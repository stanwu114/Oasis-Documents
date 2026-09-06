import { matchesShareDescription } from './share-text'
import { fetchPage, type PlatformPlugin } from './base'
import { isDouyinUrl } from './douyin-link'
import { resolveDouyin } from './douyin-resolver'

export const douyinPlugin: PlatformPlugin = {
  id: 'douyin',
  label: '抖音',
  matches: isDouyinUrl,
  async parseShareLink(url, options) {
    const result = await resolveDouyin(url, fetchPage, options?.signal, async (id, signal) => {
      options?.onProgress?.({phase: 'parsing', message: '正在加载抖音作品页面…'})
      const {readRenderedDouyin} = await import('./douyin-browser')
      return readRenderedDouyin(id, signal, url, options?.share?.text, () => {
        options?.onProgress?.({phase: 'parsing', message: '抖音要求安全验证，请在弹出的抖音窗口中手动完成；完成后自动继续下载'})
      })
    })
    const post = result.post
    if (!post.id && options?.share?.text && !matchesShareDescription(options.share.text, post.desc ?? '')) throw new Error('解析到的作品与分享文案不一致，已停止下载以避免收藏错误视频')
    return {
      platform: 'douyin', url: result.url,
      title: post.desc?.slice(0, 80) || '抖音作品', content: post.desc ?? '',
      author: post.author,
      tags: (post.desc?.match(/#[^\s#]+/g) ?? []).map(t => t.slice(1)),
      imageUrls: post.images?.length ? post.images : post.cover ? [post.cover] : [],
      videoUrl: post.videoUrl,
      videoUrls: post.videoUrls
    }
  }
}
