import { douyinPostId, isDouyinUrl } from './douyin-link'
import { extractRouterData, type DyParsed } from './douyin-data'

export const DOUYIN_MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
type PageReader = (url: string, options?: {ua?: string; signal?: AbortSignal}) => Promise<{html: string; finalUrl: string}>

/** 仅请求作品页面；收藏列表本身不作为正文或媒体导入。 */
export async function resolveDouyin(url: string, readPage: PageReader, signal?: AbortSignal, renderPage?: (id: string, signal?: AbortSignal) => Promise<DyParsed>): Promise<{post: DyParsed; url: string}> {
  if (!isDouyinUrl(url)) throw new Error('不是有效的抖音分享链接')
  let id = douyinPostId(url)
  const queue = id ? [`https://www.iesdouyin.com/share/video/${id}/`, `https://www.douyin.com/video/${id}`] : [url]
  const visited = new Set<string>()
  let lastError: unknown
  for (let cursor = 0; cursor < queue.length && cursor < 3; cursor++) {
    signal?.throwIfAborted()
    const next = queue[cursor]
    if (visited.has(next)) continue
    visited.add(next)
    try {
      const page = await readPage(next, {ua: new URL(next).hostname === 'www.iesdouyin.com' || !id ? DOUYIN_MOBILE_UA : undefined, signal})
      if (!isDouyinUrl(page.finalUrl)) throw new Error('分享链接跳转到了非抖音页面')
      const resolvedId = douyinPostId(page.finalUrl)
      if (id && resolvedId && id !== resolvedId) throw new Error('页面跳转到了其他作品')
      id ??= resolvedId
      const post = extractRouterData(page.html, id)
      if (post && (post.images?.length || post.videoUrl)) {
        const postId = id ?? post.id
        if (!postId) throw new Error('分享页没有返回作品编号')
        return {post, url: `https://www.douyin.com/${post.images?.length ? 'note' : 'video'}/${postId}`}
      }
      if (id) {
        queue.push(`https://www.iesdouyin.com/share/video/${id}/`, `https://www.douyin.com/video/${id}`)
      }
    } catch (error) { lastError = error; signal?.throwIfAborted() }
  }
  if (id && renderPage) {
    const post = await renderPage(id, signal)
    if (post.id !== id || (!post.videoUrl && !post.images?.length)) throw new Error('抖音页面返回的作品与分享链接不一致')
    return {post, url: `https://www.douyin.com/${post.images?.length ? 'note' : 'video'}/${id}`}
  }
  if (!id) throw new Error('未找到抖音作品编号，请打开具体作品后复制分享链接，不能仅粘贴主页或收藏列表地址')
  if (lastError) throw new Error(`抖音作品读取失败：${lastError instanceof Error ? lastError.message : String(lastError)}`)
  throw new Error('已识别抖音作品，但平台未返回可下载内容；帖子可能需要登录、不可见或暂时受限，请从 App 重新复制该作品的分享链接后重试')
}
