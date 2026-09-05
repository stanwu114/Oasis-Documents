import { XMLParser } from 'fast-xml-parser'
import axios from 'axios'
import { createHash } from 'node:crypto'
import { getDb } from '../db'
import { downloadImage } from '../platforms/base'

/* ================================================================
   RSS/Atom 订阅：添加（自动发现 feed）→ 拉取条目 → feed_items 时间线
   ================================================================ */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true
})

export interface FeedItemRow {
  id: string
  subscription_id: number
  title: string
  url: string
  author: string | null
  summary: string
  published_at: number
  read: number
  starred: number
}

/** 添加订阅：直接是 feed → 解析；是站点 → 自动发现 /feed /rss /atom 等常见路径 */
export async function addSubscription(input: string): Promise<{ id: number; title: string; siteUrl: string }> {
  const target = input.trim().replace(/\/$/, '')
  if (!/^https?:\/\//.test(target)) throw new Error('请输入 http(s) 链接')

  let feedUrl = target
  let parsed = await tryParseFeed(feedUrl).catch(() => null)

  if (!parsed) {
    /* 自动发现：页面里的 <link rel="alternate"> */
    const discovered = await discoverFeed(target)
    if (!discovered) throw new Error('未找到 RSS/Atom feed（可尝试直接输入 feed 地址）')
    feedUrl = discovered
    parsed = await tryParseFeed(feedUrl)
  }

  const db = getDb()
  const exist = db.prepare(`SELECT id, title FROM subscriptions WHERE feed_url = ?`).get(feedUrl) as
    | { id: number; title: string }
    | undefined
  if (exist) return { id: exist.id, title: exist.title, siteUrl: target }

  const favicon = parsed.links.find((l) => /favicon|icon/i.test(l)) ?? null
  const faviconPath = favicon ? await downloadImage(favicon, 'feed-icons') : null

  const info = db
    .prepare(
      `INSERT INTO subscriptions (kind, title, feed_url, site_url, favicon_path, created_at)
       VALUES ('rss', ?, ?, ?, ?, ?)`
    )
    .run(parsed.title || target, feedUrl, target, faviconPath, Date.now())

  await refreshSubscription(Number(info.lastInsertRowid))
  return { id: Number(info.lastInsertRowid), title: parsed.title || target, siteUrl: target }
}

/** 拉取一个订阅的全部新条目 */
export async function refreshSubscription(subId: number): Promise<number> {
  const db = getDb()
  const sub = db.prepare(`SELECT id, feed_url, title FROM subscriptions WHERE id = ?`).get(subId) as
    | { id: number; feed_url: string; title: string }
    | undefined
  if (!sub) return 0

  const parsed = await tryParseFeed(sub.feed_url)
  const insert = db.prepare(
    `INSERT OR IGNORE INTO feed_items
       (id, subscription_id, title, url, author, summary, published_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )

  let added = 0
  for (const item of parsed.items) {
    /* R30：条目主键 = 订阅上下文 + URL——同一文章出现在多个订阅中时
       各自保留归属，不再被全局 URL 主键互相覆盖 */
    const id = createHash('sha256')
      .update(`${subId}:${item.url || item.title}`)
      .digest('hex')
      .slice(0, 24)
    const r = insert.run(
      id,
      subId,
      item.title || '无标题',
      item.url ?? sub.feed_url,
      item.author ?? null,
      (item.summary ?? '').replace(/<[^>]+>/g, '').slice(0, 500),
      item.publishedAt ?? Date.now(),
      Date.now()
    )
    if (r.changes > 0) added++
  }

  db.prepare(`UPDATE subscriptions SET last_fetch = ?, unread = (SELECT COUNT(*) FROM feed_items WHERE subscription_id = ? AND read = 0) WHERE id = ?`)
    .run(Date.now(), subId, subId)
  return added
}

export async function refreshAll(): Promise<void> {
  const db = getDb()
  const subs = db.prepare(`SELECT id FROM subscriptions WHERE enabled = 1`).all() as { id: number }[]
  for (const s of subs) {
    try {
      await refreshSubscription(s.id)
    } catch (e) {
      console.warn(`[rss] 刷新失败 #${s.id}:`, e instanceof Error ? e.message : e)
    }
  }
}

/* ================================================================
   F05：RSS 持久调度——周期检查，距上次抓取超过间隔才刷新；
   连续失败 3 次的源自动禁用（可在界面重新启用）
   ================================================================ */
const MIN_INTERVAL_MS = 60 * 60 * 1000 /* 每源最小抓取间隔 1 小时 */
const failCounts = new Map<number, number>()
let schedulerTimer: NodeJS.Timeout | null = null

export function startRssScheduler(checkEveryMs = 30 * 60 * 1000): void {
  if (schedulerTimer) return
  const tick = async (): Promise<void> => {
    const db = getDb()
    const subs = db
      .prepare(`SELECT id, title, last_fetch FROM subscriptions WHERE enabled = 1`)
      .all() as { id: number; title: string; last_fetch: number | null }[]
    for (const s of subs) {
      if (s.last_fetch && Date.now() - s.last_fetch < MIN_INTERVAL_MS) continue
      try {
        await refreshSubscription(s.id)
        failCounts.set(s.id, 0)
      } catch (e) {
        const n = (failCounts.get(s.id) ?? 0) + 1
        failCounts.set(s.id, n)
        console.warn(`[rss-scheduler] ${s.title} 失败 ${n} 次:`, e instanceof Error ? e.message : e)
        if (n >= 3) {
          db.prepare(`UPDATE subscriptions SET enabled = 0 WHERE id = ?`).run(s.id)
          console.warn(`[rss-scheduler] ${s.title} 连续失败，已自动禁用`)
        }
      }
    }
  }
  /* 启动后 2 分钟做首次检查，此后周期运行 */
  setTimeout(() => void tick(), 2 * 60 * 1000)
  schedulerTimer = setInterval(() => void tick(), checkEveryMs)
}

/* ---- 内部 ---- */

interface ParsedFeed {
  title: string
  links: string[]
  items: { title: string; url?: string; author?: string; summary?: string; publishedAt?: number }[]
}

async function tryParseFeed(url: string): Promise<ParsedFeed> {
  const res = await axios.get<string>(url, {
    headers: { 'User-Agent': 'OasisDocuments/0.1 (RSS Reader)', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
    timeout: 15000,
    responseType: 'text',
    transformResponse: [(d) => d]
  })
  const xml = String(res.data)
  if (!/<rss|<feed|<channel/i.test(xml.slice(0, 2000))) throw new Error('不是 RSS/Atom 文档')

  const doc = parser.parse(xml) as Record<string, unknown>

  /* RSS 2.0: rss.channel */
  const rss = doc.rss as { channel?: Record<string, unknown> } | undefined
  if (rss?.channel) {
    const ch = rss.channel
    return {
      title: text(ch.title),
      links: collectLinks(ch),
      items: asArray(ch.item).map((it) => normalizeItem(it))
    }
  }

  /* Atom: feed.entry */
  const atom = doc.feed as Record<string, unknown> | undefined
  if (atom) {
    return {
      title: text(atom.title),
      links: collectLinks(atom),
      items: asArray(atom.entry).map((e) => {
        const links = asArray((e as Record<string, unknown>).link)
        const alt = links.find((l) => typeof l === 'object' && (l as Record<string, string>)['@_rel'] !== 'self')
        const href =
          typeof alt === 'object' ? (alt as Record<string, string>)['@_href'] : typeof alt === 'string' ? alt : undefined
        return normalizeItem(e, href)
      })
    }
  }

  throw new Error('无法识别的 feed 结构')
}

function normalizeItem(it: unknown, atomHref?: string): ParsedFeed['items'][number] {
  const o = (it ?? {}) as Record<string, unknown>
  const links = asArray(o.link)
  const rssHref =
    typeof o.link === 'string' ? o.link : typeof links[0] === 'object' ? (links[0] as Record<string, string>)['@_href'] : undefined
  const authorNode = o.author as Record<string, unknown> | string | undefined
  return {
    title: text(o.title),
    url: atomHref ?? rssHref ?? text(o.guid),
    author: text(typeof authorNode === 'string' ? authorNode : authorNode?.['name']) || text(o['dc:creator']),
    summary: text(o.summary ?? o.description ?? o.content),
    publishedAt: parseDate(text(o.pubDate ?? o.published ?? o.updated ?? o['dc:date']))
  }
}

async function discoverFeed(siteUrl: string): Promise<string | null> {
  try {
    const res = await axios.get<string>(siteUrl, {
      headers: { 'User-Agent': 'OasisDocuments/0.1' },
      timeout: 10000,
      responseType: 'text',
      transformResponse: [(d) => d]
    })
    const html = String(res.data)
    const m = html.match(/<link[^>]+type=["']application\/(rss|atom)\+xml["'][^>]*href=["']([^"']+)["']/i)
      ?? html.match(/<link[^>]+href=["']([^"']+\.(?:rss|xml|atom)["'][^>]*)["'][^>]*type=["']application\/(rss|atom)\+xml["']/i)
    if (m) {
      const href = m[2] ?? m[1]
      return new URL(href, siteUrl).toString()
    }
  } catch {
    /* 站点不可达 */
  }
  /* 常见路径探测 */
  for (const path of ['/feed', '/rss', '/rss.xml', '/atom.xml', '/feed.xml', '/index.xml']) {
    const candidate = siteUrl + path
    const ok = await tryParseFeed(candidate)
      .then(() => true)
      .catch(() => false)
    if (ok) return candidate
  }
  return null
}

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return []
  return Array.isArray(v) ? v : [v]
}

function text(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string' || typeof v === 'number') return String(v)
  if (typeof v === 'object' && '#text' in (v as Record<string, unknown>)) return String((v as Record<string, unknown>)['#text'])
  return ''
}

function collectLinks(o: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const l of asArray(o.link)) {
    const href = typeof l === 'string' ? l : (l as Record<string, string>)['@_href']
    if (href) out.push(href)
  }
  return out
}

function parseDate(s: string): number | undefined {
  if (!s) return undefined
  const t = Date.parse(s)
  return Number.isNaN(t) ? undefined : t
}
