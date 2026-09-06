import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { randomUUID } from 'node:crypto'
import { safeStorage } from 'electron'
import { getDb } from './db'
import { ftsUpsert } from './fts'

/* ================================================================
   Newsletter / IMAP 归档（报告 11.4 后置能力，进入条件已满足）
   - 凭据（IMAP 密码）经 safeStorage 加密存 settings（cred:newsletter:*）
   - 定时拉取最近未读邮件，按发件人过滤，正文入统一内容库
   - 同步记录写 sync_logs；正文进 FTS + 语义嵌入
   ================================================================ */

export interface NewsletterConf {
  enabled: boolean
  host: string
  port: number
  user: string
  /** 引用凭据行，明文仅主进程持有 */
  passwordRef: '__CRED__' | ''
  tls: boolean
  /** 只归档这些发件人包含关键字（空 = 全部） */
  fromFilters: string[]
}

const DEFAULT_CONF: NewsletterConf = {
  enabled: false,
  host: '',
  port: 993,
  user: '',
  passwordRef: '',
  tls: true,
  fromFilters: []
}

const CONF_KEY = 'newsletter'
const PWD_CRED_KEY = 'cred:newsletter:password'

function readConf(): { conf: NewsletterConf; password: string } {
  const db = getDb()
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(CONF_KEY) as { value: string } | undefined
  const conf: NewsletterConf = row ? { ...DEFAULT_CONF, ...JSON.parse(row.value) } : { ...DEFAULT_CONF }
  let password = ''
  if (conf.passwordRef === '__CRED__') {
    const cred = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(PWD_CRED_KEY) as { value: string } | undefined
    if (cred) password = decryptCred(cred.value)
  }
  return { conf, password }
}

function encryptCred(v: string): string {
  if (!safeStorage.isEncryptionAvailable()) return `__PLAIN__${v}`
  return safeStorage.encryptString(v).toString('base64')
}

function decryptCred(stored: string): string {
  if (stored.startsWith('__PLAIN__')) return stored.slice('__PLAIN__'.length)
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch {
    return ''
  }
}

export function saveNewsletterConf(input: { enabled?: boolean; host?: string; port?: number; user?: string; password?: string; tls?: boolean; fromFilters?: string[] }): NewsletterConf {
  const db = getDb()
  const { conf } = readConf()
  const next: NewsletterConf = {
    ...conf,
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.host !== undefined ? { host: input.host.trim() } : {}),
    ...(input.port !== undefined ? { port: input.port } : {}),
    ...(input.user !== undefined ? { user: input.user.trim() } : {}),
    ...(input.tls !== undefined ? { tls: input.tls } : {}),
    ...(input.fromFilters !== undefined ? { fromFilters: input.fromFilters } : {})
  }
  if (input.password !== undefined && input.password !== '') {
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(PWD_CRED_KEY, encryptCred(input.password))
    next.passwordRef = '__CRED__'
  }
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(CONF_KEY, JSON.stringify(next))
  return next
}

/** 获取配置（密码不返回，界面只显示"已配置"） */
export function getNewsletterConf(): NewsletterConf & { passwordConfigured: boolean } {
  const { conf, password } = readConf()
  return { ...conf, passwordConfigured: password.length > 0 }
}

/** 拉取最近未读邮件并归档；返回 { fetched, archived, error? } */
export async function syncNewsletter(): Promise<{ fetched: number; archived: number; error?: string }> {
  const { conf, password } = readConf()
  if (!conf.enabled || !conf.host || !conf.user || !password) {
    return { fetched: 0, archived: 0, error: '未配置或未启用' }
  }

  const client = new ImapFlow({
    host: conf.host,
    port: conf.port,
    secure: conf.tls,
    auth: { user: conf.user, pass: password },
    logger: false as unknown as undefined
  })

  const db = getDb()
  const log = db.prepare(`INSERT INTO sync_logs (platform, status, message, items_count, created_at) VALUES (?, ?, ?, ?, ?)`)
  let fetched = 0
  let archived = 0

  try {
    await client.connect()
    const lock = await client.getMailboxLock('INBOX')
    try {
      /* 最近 7 天的未读邮件 */
      const since = new Date(Date.now() - 7 * 86400_000)
      const uids = (await client.search({ since, seen: false })) as number[]
      for await (const msg of client.fetch(uids.slice(-50), { source: true, envelope: true })) {
        fetched++
        const parsed = await simpleParser(msg.source as Buffer)
        const from = parsed.from?.text ?? 'unknown'
        const subject = parsed.subject ?? '(无主题)'
        /* 发件人过滤 */
        if (conf.fromFilters.length > 0 && !conf.fromFilters.some((f) => from.toLowerCase().includes(f.toLowerCase()))) {
          continue
        }
        const body = parsed.text?.trim() || (parsed.html && typeof parsed.html === 'string' ? htmlToText(parsed.html) : '')
        const contentText = `${subject}\n\n${body}`
        if (contentText.trim().length < 20) continue

        /* 按 Message-ID 去重 */
        const mid = parsed.messageId ?? `${from}|${subject}|${parsed.date?.toISOString() ?? ''}`
        const exist = db.prepare(`SELECT 1 FROM contents WHERE url = ?`).get(`mailto:${mid}`)
        if (exist) continue

        const id = randomUUID()
        const now = Date.now()
        db.prepare(
          `INSERT INTO contents (id, type, title, content, url, platform, tags, meta, created_at, updated_at, indexed_at)
           VALUES (?, 'webpage', ?, ?, ?, 'newsletter', '[]', ?, ?, ?, ?)`
        ).run(
          id,
          subject.slice(0, 200),
          contentText.slice(0, 200_000),
          `mailto:${mid}`,
          JSON.stringify({ author: from, receivedAt: parsed.date?.toISOString() ?? null }),
          parsed.date?.getTime() ?? now,
          now,
          now
        )
        ftsUpsert(id, subject, contentText)
        /* 正文进入语义嵌入 */
        try {
          const { enqueueTextEmbed } = await import('./indexer/embedding-pipeline')
          enqueueTextEmbed(id, contentText)
        } catch {
          /* 嵌入不可用时仅全文可搜 */
        }
        archived++
      }
      /* 标记已读，避免重复拉取 */
      if (uids.length > 0) await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true })
    } finally {
      lock.release()
    }
    await client.logout()
    log.run('newsletter', 'success', null, archived, Date.now())
    return { fetched, archived }
  } catch (e) {
    log.run('newsletter', 'error', String(e instanceof Error ? e.message : e).slice(0, 300), 0, Date.now())
    try { await client.logout() } catch { /* 连接失败时无需 */ }
    return { fetched, archived, error: e instanceof Error ? e.message : String(e) }
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()
}

/* 定时调度：复用 RSS 模式（30 分钟检查） */
let timer: NodeJS.Timeout | null = null

export function startNewsletterScheduler(): void {
  if (timer) return
  const tick = async (): Promise<void> => {
    const { conf } = readConf()
    if (conf.enabled) {
      const r = await syncNewsletter()
      if (r.archived > 0) console.log(`[newsletter] 归档 ${r.archived}/${r.fetched} 封`)
      if (r.error) console.warn('[newsletter]', r.error)
    }
  }
  setTimeout(() => void tick(), 3 * 60 * 1000)
  timer = setInterval(() => void tick(), 30 * 60 * 1000)
}
