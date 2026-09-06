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
  /** 视频笔记的播放地址(导入时下载到本地,≤300MB) */
  videoUrl?: string
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

/** 抓取页面（跟随短链跳转），返回最终 URL + HTML。
 *  ua:覆盖默认桌面 UA(抖音分享落地页需手机 UA 才返回 _ROUTER_DATA) */
export async function fetchPage(url: string, opts?: { ua?: string }): Promise<{ finalUrl: string; html: string }> {
  const res = await axios.get<string>(url, {
    headers: { 'User-Agent': opts?.ua ?? UA, Accept: 'text/html,application/xhtml+xml' },
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

/** 正文抽取(段落保持):实现移至 html-text.ts 独立模块,便于单测 */
export { extractBody } from './html-text'

/* 平台图床防盗链:必须带平台站内 Referer,否则 403 */
const REFERER: Record<string, string> = {
  xiaohongshu: 'https://www.xiaohongshu.com/',
  douyin: 'https://www.douyin.com/',
  'wechat-mp': 'https://mp.weixin.qq.com/',
  csdn: 'https://www.csdn.net/'
}

function refererFor(platform: string): string {
  if (REFERER[platform]) return REFERER[platform]
  /* 通用站:取不到就从 URL 域名兜底由调用方处理 */
  return 'https://www.google.com/'
}

/** 从响应 content-type 推断扩展名(比 URL 后缀可靠,CDN 常无后缀) */
function extFromContentType(ct: string | undefined, url: string): string {
  const m = /image\/(jpe?g|png|webp|gif|avif|heic)|video\/(mp4|webm|quicktime)/i.exec(ct ?? '')
  if (m) return (m[2] ?? m[1]).replace('quicktime', 'mov').replace('jpeg', 'jpg')
  const fromUrl = (url.split('?')[0].split('.').pop() ?? '').toLowerCase()
  return /^(jpg|jpeg|png|webp|gif|avif|mp4|webm|mov)$/.test(fromUrl) ? fromUrl.replace('jpeg', 'jpg') : 'jpg'
}

/** 下载远程图片到本地媒体目录，返回本地路径(带平台 Referer 防盗链) */
export async function downloadImage(url: string, platform: string): Promise<string | null> {
  try {
    const res = await axios.get<ArrayBuffer>(url, {
      headers: {
        'User-Agent': UA,
        Referer: refererFor(platform),
        Accept: 'image/avif,image/webp,image/*,*/*'
      },
      responseType: 'arraybuffer',
      timeout: 20000
    })
    const buf = Buffer.from(res.data)
    if (buf.length < 1024) return null /* 403 页面/占位图防御 */
    const { writeFile, mkdir } = await import('node:fs/promises')
    const dir = join(getMediaDir(), 'platform', platform)
    await mkdir(dir, { recursive: true })
    const ext = extFromContentType(String(res.headers['content-type'] ?? ''), url)
    const name = `${createHash('sha1').update(url).digest('hex').slice(0, 16)}.${ext}`
    const path = join(dir, name)
    await writeFile(path, buf)
    return path
  } catch {
    return null
  }
}

/** 下载远程视频(上限 300MB,超出放弃;失败返回 null 不阻塞入库) */
export async function downloadVideo(url: string, platform: string): Promise<string | null> {
  try {
    const res = await axios.get<ArrayBuffer>(url, {
      headers: { 'User-Agent': UA, Referer: refererFor(platform) },
      responseType: 'arraybuffer',
      timeout: 120_000,
      maxContentLength: 300 * 1024 * 1024
    })
    const buf = Buffer.from(res.data)
    if (buf.length < 1024) return null
    const { writeFile, mkdir } = await import('node:fs/promises')
    const dir = join(getMediaDir(), 'platform', platform)
    await mkdir(dir, { recursive: true })
    const ext = extFromContentType(String(res.headers['content-type'] ?? ''), url)
    const name = `${createHash('sha1').update(url).digest('hex').slice(0, 16)}.${ext}`
    const path = join(dir, name)
    await writeFile(path, buf)
    return path
  } catch {
    return null
  }
}

/** 批量下载笔记图片(并发 4,上限 20 张):返回本地路径列表(失败的跳过) */
export async function downloadAllImages(urls: string[], platform: string, max = 20): Promise<string[]> {
  const list = urls.filter(Boolean).slice(0, max)
  const out: string[] = []
  const CONC = 4
  for (let i = 0; i < list.length; i += CONC) {
    const batch = await Promise.all(list.slice(i, i + CONC).map((u) => downloadImage(u, platform)))
    for (const p of batch) if (p) out.push(p)
  }
  return out
}

/** 平台内容入库（去重按 URL；AI 打标——在线文本模型优先，本地抽取兜底）。
 *  图文落地:全部图片(≤20)带防盗链头下载到本地,视频(≤300MB)同存,
 *  meta.imageUrls 存本地路径——远端 URL 会过期/防盗链,不依赖它展示 */
export async function savePlatformContent(c: PlatformContent): Promise<{ id: string; created: boolean; images: number; video: boolean }> {
  const db = getDb()
  const existing = db.prepare(`SELECT id FROM contents WHERE url = ?`).get(c.url) as { id: string } | undefined
  if (existing) return { id: existing.id, created: false, images: 0, video: false }

  /* 全量图片落地,首图即缩略图 */
  const localImages = await downloadAllImages(c.imageUrls, c.platform)
  const thumb = localImages[0] ?? null
  const videoPath = c.videoUrl ? await downloadVideo(c.videoUrl, c.platform) : null

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
    JSON.stringify({
      author: c.author ?? null,
      imageUrls: localImages,
      remoteImages: c.imageUrls.slice(0, 20),
      videoPath,
      videoUrl: c.videoUrl ?? null,
      /* 空图文可见化:详情页/系统状态页据此提示,不再静默 */
      ...(localImages.length === 0 && !videoPath ? { parseStatus: 'no-media' } : {}),
      tagEngine: ai.engine
    }),
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
  return { id, created: true, images: localImages.length, video: Boolean(videoPath) }
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
