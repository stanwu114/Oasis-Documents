import * as cheerio from 'cheerio'
import { extractMeta, extractBody, fetchPage, type PlatformContent, type PlatformPlugin } from './base'
import { extractRouterData } from './douyin-data'

/* ================================================================
   抖音：分享短链（v.douyin.com）→ iesdouyin 移动分享落地页
   要点:
   - 必须用手机 UA——桌面 UA 拿到的页面没有 _ROUTER_DATA
   - 路由数据提取/直链兜底逻辑在 douyin-data.ts(纯函数,配单测)
   ================================================================ */

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

export const douyinPlugin: PlatformPlugin = {
  id: 'douyin',
  label: '抖音',
  matches(url: string): boolean {
    return /v\.douyin\.com|douyin\.com\/video|douyin\.com\/note|iesdouyin\.com/i.test(url)
  },
  async parseShareLink(url: string): Promise<PlatformContent> {
    /* 手机 UA:分享短链 302 到 iesdouyin 移动页,桌面 UA 拿不到路由数据 */
    const { finalUrl, html } = await fetchPage(url, { ua: MOBILE_UA })
    const $ = cheerio.load(html)
    const meta = extractMeta($)
    const v = extractRouterData(html)

    return {
      platform: 'douyin',
      title: v?.desc ?? meta.title ?? '抖音视频',
      content: v?.desc ?? meta.description ?? extractBody($, ['[data-e2e="video-desc"]', 'article']),
      url: finalUrl,
      author: v?.author,
      tags: (v?.desc?.match(/#[^\s#]+/g) ?? []).map((t) => t.slice(1)),
      /* 图集作品取全部图;视频作品取封面 */
      imageUrls: v?.images?.length ? v.images : [v?.cover ?? meta.image].filter(Boolean) as string[],
      videoUrl: v?.videoUrl
    }
  }
}
