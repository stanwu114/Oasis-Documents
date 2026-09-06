import { randomUUID, createHash } from 'node:crypto'
import axios from 'axios'
import * as cheerio from 'cheerio'
import { join } from 'node:path'
import { downloadMediaCandidates, videoThumbnail } from './media-download'
import type { PlatformProgress } from '../../shared/ipc'
import { getMediaDir } from '../dataLocation'
import { getDb } from '../db'
import { autoTag, mergeTags } from '../autotag'

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
  videoUrls?: string[]
  shareText?: string
  shareCode?: string
}

export interface ImportOptions { signal?: AbortSignal; onProgress?: (progress: PlatformProgress) => void; existingId?: string; share?: import('./share-text').ShareInfo }

export interface PlatformPlugin {
  id: string
  label: string
  /** 该链接是否归本插件处理 */
  matches(url: string): boolean
  parseShareLink(url: string, options?: ImportOptions): Promise<PlatformContent>
}

export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 抓取页面（跟随短链跳转），返回最终 URL + HTML。
 *  ua:覆盖默认桌面 UA(抖音分享落地页需手机 UA 才返回 _ROUTER_DATA) */
export async function fetchPage(url: string, opts?: { ua?: string; signal?: AbortSignal }): Promise<{ finalUrl: string; html: string }> {
  const res = await axios.get<string>(url, {
    headers: { 'User-Agent': opts?.ua ?? UA, Accept: 'text/html,application/xhtml+xml' },
    signal: opts?.signal,
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

function contentKey(c: PlatformContent): string {
  const postId = new URL(c.url).pathname.match(/\/(?:explore|item|video|note)\/([a-zA-Z0-9]+)/)?.[1]
  return postId ? `${c.platform}:${postId}` : c.url
}

const saves = new Map<string, Promise<unknown>>()
export async function savePlatformContent(c: PlatformContent, options: ImportOptions = {}): Promise<{ id: string; created: boolean; images: number; video: boolean; warnings: string[] }> {
  const key = contentKey(c)
  const previous = saves.get(key)
  const task = (async () => { await previous?.catch(() => undefined); return persistPlatformContent(c, options) })()
  saves.set(key, task)
  try { return await task } finally { if (saves.get(key) === task) saves.delete(key) }
}

/** 所有媒体使用同一下载器，失败保留原因供界面提示。 */
async function persistPlatformContent(c: PlatformContent, options: ImportOptions): Promise<{ id: string; created: boolean; images: number; video: boolean; warnings: string[] }> {
  const db = getDb()
  const importKey = contentKey(c)
  const existing = db.prepare(`SELECT id, meta, tags, thumbnail_path FROM contents WHERE id = ? OR url = ? OR json_extract(meta, '$.importKey') = ? LIMIT 1`).get(options.existingId ?? '', c.url, importKey) as {id: string; meta: string; tags: string; thumbnail_path: string | null} | undefined
  const id = existing?.id ?? randomUUID()
  const old = existing ? JSON.parse(existing.meta || '{}') : {}
  const warnings: string[] = []
  const urls = [...new Set(c.imageUrls.filter(Boolean))]
  const total = urls.length + (c.videoUrl ? 1 : 0)
  let completed = 0
  const report = (): void => options.onProgress?.({ phase: 'downloading', completed, total })
  report()
  const download = async (url: string, kind: 'image' | 'video'): Promise<string | null> => {
    try {
      return await downloadMediaCandidates(kind === 'video' ? [url, ...(c.videoUrls ?? [])] : [url], join(getMediaDir(), 'platform', c.platform.replace(/[^a-zA-Z0-9.-]/g, '_'), id, createHash('sha1').update(url).digest('hex').slice(0, 16)), kind, { 'User-Agent': UA, Referer: refererFor(c.platform) }, options.signal)
    } catch (error) {
      warnings.push(`${kind === 'image' ? '图片' : '视频'}下载失败：${options.signal?.aborted ? '任务超时或已取消' : error instanceof Error ? error.message : String(error)}`)
      return null
    } finally { completed++; report() }
  }
  const images: (string | null)[] = new Array(urls.length).fill(null)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < urls.length && !options.signal?.aborted) {
      const index = cursor++
      images[index] = await download(urls[index], 'image')
    }
  }
  const [, downloadedVideo] = await Promise.all([
    Promise.all(Array.from({length: Math.min(4, urls.length)}, worker)),
    c.videoUrl ? download(c.videoUrl, 'video') : Promise.resolve(null)
  ])
  const downloadedImages = images.filter((path): path is string => Boolean(path))
  if (options.signal?.aborted && !warnings.length) warnings.push('下载任务超时或已取消')
  // 重抓失败时保留之前已落地的媒体，避免用空结果覆盖收藏。
  const mediaByUrl: Record<string, string> = {...old.mediaByUrl}
  images.forEach((path, index) => { if (path) mediaByUrl[urls[index]] = path })
  const localImages = urls.map((url) => mediaByUrl[url]).filter((path): path is string => typeof path === 'string')
  if (!localImages.length && Array.isArray(old.imageUrls)) localImages.push(...old.imageUrls)
  const videoPath = downloadedVideo ?? old.videoPath ?? null
  const thumbnail = localImages[0] ?? (videoPath ? await videoThumbnail(videoPath) : null) ?? existing?.thumbnail_path ?? null
  const tags = mergeTags(existing ? JSON.parse(existing.tags || '[]') : autoTag(c.title, c.content), c.tags)
  const now = Date.now()
  const meta = { ...old, shareText: c.shareText ?? old.shareText, shareCode: c.shareCode ?? old.shareCode, mediaByUrl, author: c.author ?? null, imageUrls: localImages, remoteImages: urls, videoPath, videoUrl: c.videoUrl ?? null, importKey, parseStatus: warnings.length ? (localImages.length || videoPath ? 'partial' : 'failed') : 'complete', downloadWarnings: warnings, tagEngine: old.tagEngine ?? 'local' }
  options.onProgress?.({phase: 'saving', completed, total})
  if (existing) {
    db.prepare(`UPDATE contents SET title = ?, content = ?, url = ?, thumbnail_path = ?, tags = ?, meta = ?, updated_at = ? WHERE id = ?`).run(c.title, c.content, c.url, thumbnail, JSON.stringify(tags), JSON.stringify(meta), now, id)
  } else {
    db.prepare(`INSERT INTO contents (id, type, title, content, url, platform, thumbnail_path, tags, meta, created_at, updated_at, indexed_at) VALUES (?, 'webpage', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, c.title || '未命名内容', c.content, c.url, c.platform, thumbnail, JSON.stringify(tags), JSON.stringify(meta), now, now, now)
  }
  try {
    const { ftsUpsert } = await import('../fts')
    ftsUpsert(id, c.title, c.content)
  } catch { /* FTS 尚未就绪 */ }
  // 向量/在线模型不阻塞收藏落地。
  void import('../indexer/embedding-pipeline').then(({enqueueTextEmbed}) => enqueueTextEmbed(id, `${c.title}\n\n${c.content}`)).catch(() => undefined)
  return { id, created: !existing, images: downloadedImages.length, video: Boolean(downloadedVideo), warnings }
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
