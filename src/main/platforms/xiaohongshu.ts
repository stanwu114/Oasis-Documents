import { fetchPage, type PlatformContent, type PlatformPlugin } from './base'
import { extractXhsNote, xhsMedia } from './xhs-data'

export const xiaohongshuPlugin: PlatformPlugin = {
  id: 'xiaohongshu', label: '小红书',
  matches(url): boolean {
    return /(^|\.)(xiaohongshu\.com|xhslink\.(com|cn))$/i.test(new URL(url).hostname)
  },
  async parseShareLink(url, options): Promise<PlatformContent> {
    const { finalUrl, html } = await fetchPage(url, { signal: options?.signal })
    const noteId = new URL(finalUrl).pathname.match(/\/(?:explore|item)\/([a-z\d]+)/i)?.[1]
    const note = extractXhsNote(html, noteId)
    if (!note) throw new Error('小红书未返回帖子数据，链接可能过期、帖子不可见或需要登录。请从原帖重新复制完整分享链接（含 xsec_token）')
    const media = xhsMedia(note)
    if (!media.imageUrls.length && !media.videoUrl) throw new Error('小红书未返回可下载的图片或视频，请重新复制原帖分享链接后重试')
    return {
      platform: 'xiaohongshu', title: note.title || note.desc?.slice(0, 60) || '小红书笔记',
      content: note.desc ?? '', url: finalUrl, author: note.user?.nickname,
      tags: note.tagList?.map((t) => t.name).filter((t): t is string => Boolean(t)) ?? [], ...media
    }
  }
}
