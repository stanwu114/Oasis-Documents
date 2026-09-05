import * as cheerio from 'cheerio'
import { extractMeta, extractBody, fetchPage, type PlatformContent, type PlatformPlugin } from './base'

/* ================================================================
   微信公众号：mp.weixin.qq.com 文章页可直接抓取
   正文 #js_content，作者 #js_name，元数据 var msg_*
   ================================================================ */

export const wechatPlugin: PlatformPlugin = {
  id: 'wechat-mp',
  label: '微信公众号',
  matches(url: string): boolean {
    return /mp\.weixin\.qq\.com/i.test(url)
  },
  async parseShareLink(url: string): Promise<PlatformContent> {
    const { finalUrl, html } = await fetchPage(url)
    const $ = cheerio.load(html)
    const meta = extractMeta($)

    /* 公众号页面把关键元数据写在 var msg_title = "..." 等脚本变量里 */
    const jsVar = (name: string): string => {
      const m = html.match(new RegExp(`var ${name} = '(.*?)'`)) ?? html.match(new RegExp(`var ${name} = "(.*?)"`))
      return m?.[1] ? decodeJsString(m[1]) : ''
    }

    /* 正文图片：js_content 内的 data-src 才是真实地址 */
    const imageUrls: string[] = []
    $('#js_content img').each((_, el) => {
      const src = $(el).attr('data-src') ?? $(el).attr('src')
      if (src?.startsWith('http')) imageUrls.push(src)
    })

    return {
      platform: 'wechat-mp',
      title: jsVar('msg_title') || meta.title || '公众号文章',
      content:
        extractBody($, ['#js_content', '#js_article', 'article']) ||
        jsVar('msg_desc') ||
        meta.description,
      url: finalUrl,
      author: $('#js_name').text().trim() || jsVar('nickname') || undefined,
      tags: [],
      imageUrls: imageUrls.slice(0, 18)
    }
  }
}

function decodeJsString(s: string): string {
  return s
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\"/g, '"')
}
