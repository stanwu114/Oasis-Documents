import * as cheerio from 'cheerio'
import { extractMeta, extractBody, fetchPage, type PlatformContent, type PlatformPlugin } from './base'

/* ================================================================
   小红书：分享短链（xhslink.com）→ 跳转笔记页
   页面为 SSR，og 标签 + window.__INITIAL_STATE__ 均可用
   ================================================================ */

interface XhsNote {
  title?: string
  desc?: string
  user?: { nickname?: string }
  tagList?: { name?: string }[]
  imageList?: { urlDefault?: string; url?: string; infoList?: { url?: string }[] }[]
  video?: unknown
}

export const xiaohongshuPlugin: PlatformPlugin = {
  id: 'xiaohongshu',
  label: '小红书',
  matches(url: string): boolean {
    return /xhslink\.com|xiaohongshu\.com/i.test(url)
  },
  async parseShareLink(url: string): Promise<PlatformContent> {
    const { finalUrl, html } = await fetchPage(url)
    const $ = cheerio.load(html)
    const meta = extractMeta($)

    /* __INITIAL_STATE__ 里有结构化笔记数据（标题/正文/图片列表/视频） */
    const note = extractNote(html)
    const title = note?.title ?? meta.title
    const desc = note?.desc ?? meta.description
    /* 图取最高清可用地址:infoList 多尺寸取最后一个(通常最大),回退 urlDefault */
    const images: string[] =
      note?.imageList
        ?.map((i) => i.infoList?.[i.infoList.length - 1]?.url ?? i.urlDefault ?? i.url ?? '')
        .filter(Boolean) ?? (meta.image ? [meta.image] : [])

    return {
      platform: 'xiaohongshu',
      title: title || '小红书笔记',
      content: desc || extractBody($, ['#detail-desc', '.note-text', 'article']),
      url: finalUrl,
      author: note?.user?.nickname,
      tags: note?.tagList?.map((t) => t.name).filter((n): n is string => Boolean(n)) ?? [],
      imageUrls: images.slice(0, 18),
      videoUrl: extractVideoUrl(note?.video)
    }
  }
}

/* 视频笔记:stream 按编码分档,取 h264 → h265 → av1 首档的直链 */
function extractVideoUrl(video: unknown): string | undefined {
  if (!video || typeof video !== 'object') return undefined
  const stream = (video as { media?: { stream?: Record<string, unknown[]> } }).media?.stream
  if (!stream) return undefined
  for (const codec of ['h264', 'h265', 'av1']) {
    const arr = stream[codec]
    if (Array.isArray(arr) && arr.length > 0) {
      const first = arr[0] as { master_url?: string; backup_urls?: string[] }
      const u = first.master_url ?? first.backup_urls?.[0]
      if (u) return u
    }
  }
  return undefined
}

/* 从页面脚本里抠 __INITIAL_STATE__ 的笔记数据(容错:截取到 </script> 前)。
   实际结构是 state.note.noteMap[noteId](可能再包一层 .note),
   直接读 state.note 拿不到字段——旧实现因此只落到 og 标签兜底 */
function extractNote(html: string): XhsNote | null {
  const marker = '__INITIAL_STATE__='
  const start = html.indexOf(marker)
  if (start < 0) return null
  const raw = html.slice(start + marker.length, html.indexOf('</script>', start))
  try {
    /* 小红书的 state 是未加引号的 JS 对象字面量，常见键都带引号，先直接 parse */
    const state = JSON.parse(raw.replace(/;$/, '')) as {
      note?: { currentNoteId?: string; noteMap?: Record<string, { note?: XhsNote } & XhsNote> } & XhsNote
    }
    const n = state.note
    if (!n) return null
    const map = n.noteMap
    if (map) {
      const key = n.currentNoteId ?? Object.keys(map)[0]
      const entry = (key ? map[key] : undefined) ?? Object.values(map)[0]
      if (!entry) return null
      return (entry.note as XhsNote | undefined) ?? (entry as XhsNote)
    }
    return n
  } catch {
    return null
  }
}
