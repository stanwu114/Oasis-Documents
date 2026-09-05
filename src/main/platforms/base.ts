import { randomUUID, createHash } from 'node:crypto'
import axios from 'axios'
import * as cheerio from 'cheerio'
import { join } from 'node:path'
import { getMediaDir } from '../dataLocation'
import { getDb } from '../db'
import { autoTagSmart, mergeTags } from '../autotag'

/* ================================================================
   平台插件基座（L1：分享链接解析）
   统一内容模型 → contents 表（type='webpage'）
   ================================================================ */

export interface PlatformContent {
  platform: string
  title: string
  content: string
  url: string
  author?: string
  tags: string[]
  imageUrls: string[]
}

export interface PlatformPlugin {
  id: string
  label: string
  /** 该链接是否归本插件处理 */
  matches(url: string): boolean
  parseShareLink(url: string): Promise<PlatformContent>
}

export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 抓取页面（跟随短链跳转），返回最终 URL + HTML */
export async function fetchPage(url: string): Promise<{ finalUrl: string; html: string }> {
  const res = await axios.get<string>(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    maxRedirects: 5,
    timeout: 15000,
    responseType: 'text',
    transformResponse: [(d) => d]
  })
  return { finalUrl: res.request?.res?.responseUrl ?? res.config.url ?? url, html: String(res.data) }
}

/** og/meta 标签 + 正文提取的通用骨架 */
export function extractMeta($: cheerio.CheerioAPI): { title: string; description: string; image: string } {
  const meta = (prop: string): string =>
    $(`meta[property="${prop}"]`).attr('content')?.trim() ||
    $(`meta[name="${prop}"]`).attr('content')?.trim() ||
    ''
  return {
    title: meta('og:title') || $('title').text().trim(),
    description: meta('og:description') || meta('description'),
    image: meta('og:image')
  }
}

/** 正文文本：优先选择器，退化为去噪全文 */
export function extractBody($: cheerio.CheerioAPI, selectors: string[]): string {
  for (const sel of selectors) {
    const el = $(sel)
    if (el.length) {
      const text = el
        .find('script,style,nav,footer,header,aside')
        .remove()
        .end()
        .text()
        .replace(/\s+/g, ' ')
        .trim()
      if (text.length > 80) return text.slice(0, 100_000)
    }
  }
  /* 兜底：body 文本密度 */
  $('script,style,nav,footer,header,aside,noscript').remove()
  return $('body').text().replace(/\s+/g, ' ').trim().slice(0, 50_000)
}

/** 下载远程图片到本地媒体目录，返回本地路径 */
export async function downloadImage(url: string, platform: string): Promise<string | null> {
  try {
    const res = await axios.get<ArrayBuffer>(url, {
      headers: { 'User-Agent': UA },
      responseType: 'arraybuffer',
      timeout: 15000
    })
    const { writeFile, mkdir } = await import('node:fs/promises')
    const dir = join(getMediaDir(), 'platform', platform)
    await mkdir(dir, { recursive: true })
    const ext = (url.split('.').pop() ?? 'jpg').split('?')[0].slice(0, 4) || 'jpg'
    const name = `${createHash('sha1').update(url).digest('hex').slice(0, 16)}.${ext}`
    const path = join(dir, name)
    await writeFile(path, Buffer.from(res.data))
    return path
  } catch {
    return null
  }
}

/** 平台内容入库（去重按 URL；AI 打标——在线文本模型优先，本地抽取兜底） */
export async function savePlatformContent(c: PlatformContent): Promise<{ id: string; created: boolean }> {
  const db = getDb()
  const existing = db.prepare(`SELECT id FROM contents WHERE url = ?`).get(c.url) as { id: string } | undefined
  if (existing) return { id: existing.id, created: false }

  /* 首图下载为缩略图 */
  const thumb = c.imageUrls[0] ? await downloadImage(c.imageUrls[0], c.platform) : null

  /* AI 打标（LLM 归纳 → 本地关键短语兜底）与平台原生标签合并 */
  const ai = await autoTagSmart(c.title, c.content)
  const tags = mergeTags(ai.tags, c.tags)

  const id = randomUUID()
  const now = Date.now()
  db.prepare(
    `INSERT INTO contents
       (id, type, title, content, url, platform, thumbnail_path, tags, meta, created_at, updated_at, indexed_at)
     VALUES (?, 'webpage', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    c.title || '未命名内容',
    c.content,
    c.url,
    c.platform,
    thumb,
    JSON.stringify(tags),
    JSON.stringify({ author: c.author ?? null, imageUrls: c.imageUrls.slice(0, 9), tagEngine: ai.engine }),
    now,
    now,
    now
  )
  /* R19：收藏正文进入统一嵌入队列（模型就绪时即被语义检索覆盖） */
  try {
    const { enqueueTextEmbed } = await import('../indexer/embedding-pipeline')
    enqueueTextEmbed(id, `${c.title}\n\n${c.content}`)
  } catch (e) {
    console.warn('[platforms] 收藏入队失败:', e instanceof Error ? e.message : e)
  }
  /* 全文索引同步写入 */
  try {
    const { ftsUpsert } = await import('../fts')
    ftsUpsert(id, c.title, c.content)
  } catch {
    /* FTS 不可用时跳过 */
  }
  return { id, created: true }
}

/* ---- 插件注册表 ---- */
const plugins: PlatformPlugin[] = []

export function registerPlugin(p: PlatformPlugin): void {
  if (!plugins.some((x) => x.id === p.id)) plugins.push(p)
}

export function findPluginFor(url: string): PlatformPlugin | null {
  return plugins.find((p) => p.matches(url)) ?? null
}

export function listPlugins(): { id: string; label: string }[] {
  return plugins.map((p) => ({ id: p.id, label: p.label }))
}
