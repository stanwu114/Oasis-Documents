import { getDb } from '../db'
import { UA } from './base'
import type { PlatformContent } from './base'

/* ================================================================
   外部解析服务接入(可选,用户自建):
   - 小红书:XHS-Downloader 的 API 模式(POST /xhs/detail)
     https://github.com/JoeanAmier/XHS-Downloader  (GPL-3.0,独立进程运行,
     本项目仅通过 HTTP 调用,不捆绑其代码)
   - 抖音:Douyin_TikTok_Download_API(GET /api/hybrid/video_data)
     https://github.com/Evil0ctal/Douyin_TikTok_Download_API (Apache-2.0)
   配置了对应服务地址时,导入/重抓优先走外部解析(签名与风控由其处理),
   失败自动回落内置解析器。
   ================================================================ */

export interface MediaParserConf {
  /** XHS-Downloader API 地址,如 http://127.0.0.1:5556 */
  xhs?: string
  /** 内置托管模式:解析前自动拉起应用管理的小红书引擎 */
  builtinXhs?: boolean
  /** Douyin_TikTok_Download_API 地址,如 http://127.0.0.1:8080 */
  douyin?: string
}

const CONF_KEY = 'media_parser'

export function getMediaParserConf(): MediaParserConf {
  try {
    const row = getDb().prepare(`SELECT value FROM settings WHERE key = ?`).get(CONF_KEY) as
      | { value: string }
      | undefined
    return row ? (JSON.parse(row.value) as MediaParserConf) : {}
  } catch {
    return {}
  }
}

export function saveMediaParserConf(conf: MediaParserConf): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(CONF_KEY, JSON.stringify(conf))
}

/** 探活:两个服务都是 FastAPI,/docs 返回 200 即在线 */
export async function testMediaParser(base: string): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 5000)
    const res = await fetch(`${base.replace(/\/+$/, '')}/docs`, { signal: ctrl.signal })
    clearTimeout(t)
    return res.ok
  } catch {
    return false
  }
}

/* ---- XHS-Downloader:POST /xhs/detail,响应为中文键的作品数据 ---- */
interface XhsDetail {
  '作品标题'?: string
  '作品描述'?: string
  '作品类型'?: string
  '作者昵称'?: string
  '作品标签'?: string[]
  '图片下载地址'?: string[]
  '视频下载地址'?: string
  [k: string]: unknown
}

async function parseViaXhsServer(base: string, url: string): Promise<PlatformContent | null> {
  const res = await fetch(`${base.replace(/\/+$/, '')}/xhs/detail`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, download: false }),
    signal: AbortSignal.timeout(60_000)
  })
  if (!res.ok) throw new Error(`XHS 服务 HTTP ${res.status}`)
  const data = (await res.json()) as XhsDetail
  const images = Array.isArray(data['图片下载地址'])
    ? data['图片下载地址'].filter((u): u is string => typeof u === 'string' && u.startsWith('http'))
    : []
  const video = typeof data['视频下载地址'] === 'string' ? data['视频下载地址'] : undefined
  if (images.length === 0 && !video) return null /* 解析失败或风控,回落内置 */

  const desc = data['作品描述'] ?? ''
  return {
    platform: 'xiaohongshu',
    title: data['作品标题'] || desc.slice(0, 50) || '小红书笔记',
    content: desc,
    url,
    author: data['作者昵称'],
    tags: Array.isArray(data['作品标签'])
      ? data['作品标签'].map((t) => String(t).replace(/^#/, '')).filter(Boolean).slice(0, 20)
      : [],
    imageUrls: images.slice(0, 20),
    videoUrl: video
  }
}

/* ---- Douyin_TikTok_Download_API:GET /api/hybrid/video_data ---- */
interface DyHybrid {
  code?: number
  data?: {
    type?: string
    desc?: string
    nickname?: string
    nwm_video_url?: string
    nwm_video_url_H265?: string
    images?: string[]
    url?: string
    [k: string]: unknown
  }
}

async function parseViaDouyinServer(base: string, url: string): Promise<PlatformContent | null> {
  const res = await fetch(
    `${base.replace(/\/+$/, '')}/api/hybrid/video_data?url=${encodeURIComponent(url)}&minimal=false`,
    { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60_000) }
  )
  if (!res.ok) throw new Error(`抖音服务 HTTP ${res.status}`)
  const json = (await res.json()) as DyHybrid
  const d = json.data ?? {}
  const images = Array.isArray(d.images)
    ? d.images.filter((u): u is string => typeof u === 'string' && u.startsWith('http'))
    : []
  const video = d.nwm_video_url ?? d.nwm_video_url_H265
  if (images.length === 0 && !video) return null

  const desc = d.desc ?? ''
  return {
    platform: 'douyin',
    title: desc.slice(0, 60) || '抖音作品',
    content: desc,
    url,
    author: d.nickname,
    tags: [],
    imageUrls: images.slice(0, 20),
    videoUrl: video
  }
}

/**
 * 用外部服务解析小红书/抖音链接;未配置对应服务或解析失败返回 null,
 * 调用方回落内置解析器。返回的 content 里带上 engine 标记。
 */
export async function parseWithExternalService(url: string): Promise<PlatformContent | null> {
  const conf = getMediaParserConf()
  const isXhs = /xhslink\.com|xiaohongshu\.com/i.test(url)
  /* 内置模式:小红书链接先确保引擎在线(首次拉起含健康等待) */
  if (isXhs && conf.builtinXhs) {
    const { ensureXhsRunning } = await import('./xhs-sidecar')
    await ensureXhsRunning().catch(() => undefined)
  }
  const isDy = /douyin\.com|iesdouyin\.com|tiktok\.com/i.test(url)
  try {
    if (isXhs && conf.xhs) {
      const c = await parseViaXhsServer(conf.xhs, url)
      if (c) return c
    }
    if (isDy && conf.douyin) {
      const c = await parseViaDouyinServer(conf.douyin, url)
      if (c) return c
    }
  } catch (e) {
    console.warn('[platforms] 外部解析服务失败,回落内置:', e instanceof Error ? e.message : e)
  }
  return null
}
