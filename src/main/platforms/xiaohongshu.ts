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
  imageList?: { urlDefault?: string; url?: string }[]
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

    /* __INITIAL_STATE__ 里有结构化笔记数据（标题/正文/图片列表） */
    const note = extractNote(html)
    const title = note?.title ?? meta.title
    const desc = note?.desc ?? meta.description
    const images: string[] =
      note?.imageList?.map((i) => i.urlDefault ?? i.url ?? '').filter(Boolean) ??
      (meta.image ? [meta.image] : [])

    return {
      platform: 'xiaohongshu',
      title: title || '小红书笔记',
      content: desc || extractBody($, ['#detail-desc', '.note-text', 'article']),
      url: finalUrl,
      author: note?.user?.nickname,
      tags: note?.tagList?.map((t) => t.name).filter((n): n is string => Boolean(n)) ?? [],
      imageUrls: images.slice(0, 18)
    }
  }
}

/* 从页面脚本里抠 __INITIAL_STATE__.note（容错：截取到 </script> 前的 JSON 片段） */
function extractNote(html: string): XhsNote | null {
  const marker = '__INITIAL_STATE__='
  const start = html.indexOf(marker)
  if (start < 0) return null
  const raw = html.slice(start + marker.length, html.indexOf('</script>', start))
  try {
    /* 小红书的 state 是未加引号的 JS 对象字面量，常见键都带引号，先直接 parse */
    const state = JSON.parse(raw.replace(/;$/, '')) as { note?: XhsNote }
    return state.note ?? null
  } catch {
    return null
  }
}
