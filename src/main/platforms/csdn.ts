import * as cheerio from 'cheerio'
import { extractMeta, extractBody, fetchPage, type PlatformContent, type PlatformPlugin } from './base'

/* ================================================================
   CSDN：反爬最弱，博客文章直接 GET
   正文 #content_views，作者 .follow-nickname / meta
   ================================================================ */

export const csdnPlugin: PlatformPlugin = {
  id: 'csdn',
  label: 'CSDN',
  matches(url: string): boolean {
    return /csdn\.net/i.test(url)
  },
  async parseShareLink(url: string): Promise<PlatformContent> {
    const { finalUrl, html } = await fetchPage(url)
    const $ = cheerio.load(html)
    const meta = extractMeta($)

    const imageUrls: string[] = []
    if (meta.image) imageUrls.push(meta.image)
    $('#content_views img').each((_, el) => {
      const src = $(el).attr('src')
      if (src?.startsWith('http')) imageUrls.push(src)
    })

    /* 标签栏 */
    const tags: string[] = []
    $('.tag-link, #blogColumn > a, .blog_tags a').each((_, el) => {
      const t = $(el).text().trim()
      if (t) tags.push(t)
    })

    return {
      platform: 'csdn',
      title: meta.title || $('h1').first().text().trim() || 'CSDN 文章',
      content: extractBody($, ['#content_views', 'article', '#content']),
      url: finalUrl,
      author:
        $('.follow-nickname, .user_name, #uid').first().text().trim() ||
        $('meta[name="author"]').attr('content') ||
        undefined,
      tags: tags.slice(0, 10),
      imageUrls: [...new Set(imageUrls)].slice(0, 9)
    }
  }
}
