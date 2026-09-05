import * as cheerio from 'cheerio'
import { extractMeta, extractBody, fetchPage, type PlatformContent, type PlatformPlugin } from './base'

/* ================================================================
   抖音：分享短链（v.douyin.com）→ 跳转视频页
   页面 RENDER_DATA（URL encode 的 JSON）与 og 标签可用
   视频本体不下载（版权），存封面 + 简介 + 外链
   ================================================================ */

export const douyinPlugin: PlatformPlugin = {
  id: 'douyin',
  label: '抖音',
  matches(url: string): boolean {
    return /v\.douyin\.com|douyin\.com\/video|iesdouyin\.com/i.test(url)
  },
  async parseShareLink(url: string): Promise<PlatformContent> {
    const { finalUrl, html } = await fetchPage(url)
    const $ = cheerio.load(html)
    const meta = extractMeta($)

    const video = extractRenderData(html)

    return {
      platform: 'douyin',
      title: video?.desc ?? meta.title ?? '抖音视频',
      content: video?.desc ?? meta.description ?? extractBody($, ['[data-e2e="video-desc"]', 'article']),
      url: finalUrl,
      author: video?.author,
      tags: (video?.desc?.match(/#[^\s#]+/g) ?? []).map((t) => t.slice(1)),
      imageUrls: [video?.cover ?? meta.image].filter(Boolean) as string[]
    }
  }
}

/** 抠 _ROUTER_DATA / RENDER_DATA（douyin 页面数据是 encodeURIComponent 的 JSON） */
function extractRenderData(html: string): { desc?: string; author?: string; cover?: string } | null {
  interface DyVideo {
    desc?: string
    author?: { nickname?: string } | string
    avatarInfo?: { nickname?: string }
    video?: { cover?: { url_list?: string[] }; originCover?: { url_list?: string[] } }
    cover?: { url_list?: string[] }
  }
  for (const marker of ['_ROUTER_DATA = ', 'RENDER_DATA=']) {
    const start = html.indexOf(marker)
    if (start < 0) continue
    const end = html.indexOf('</script>', start)
    const raw = html.slice(start + marker.length, end).replace(/;$/, '')
    try {
      const decoded = decodeURIComponent(raw)
      const obj = JSON.parse(decoded) as Record<string, unknown>
      const loader = (obj.loaderData ?? obj) as Record<string, unknown>
      const page = Object.values(loader).find((v) => v && typeof v === 'object') as Record<string, unknown> | undefined
      const info = (page?.videoInfoRes ?? page?.item_list ?? page) as Record<string, unknown> | undefined
      if (!info) return null
      const list = (info.item_list ?? []) as DyVideo[]
      const item: DyVideo = list[0] ?? (info.video as DyVideo | undefined) ?? (info as unknown as DyVideo)
      const author = item.author ?? item.avatarInfo
      return {
        desc: typeof item.desc === 'string' ? item.desc : undefined,
        author: typeof author === 'string' ? author : author?.nickname,
        cover: item.video?.originCover?.url_list?.[0] ?? item.video?.cover?.url_list?.[0] ?? item.cover?.url_list?.[0]
      }
    } catch {
      continue
    }
  }
  return null
}
