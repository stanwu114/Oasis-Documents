import * as cheerio from 'cheerio'

/* ================================================================
   HTML → 保留段落结构的纯文本(收藏全文保存/阅读弹窗共用)
   抽成独立模块便于单测(不引入 db/electron 依赖)
   ================================================================ */

/** 块级元素:其后补空行,保住段落结构 */
const BLOCK_SEL = 'p,div,li,h1,h2,h3,h4,h5,h6,section,article,blockquote,pre,tr,figure'

/**
 * DOM → 保留段落结构的纯文本:
 * <br> 转换行、块级元素后补空行——阅读弹窗按 \n\n 分段渲染,
 * 若把全部空白压成单空格,整篇正文会变成一段文字墙
 */
export function domToText(el: ReturnType<cheerio.CheerioAPI>): string {
  const c = el.clone()
  c.find('script,style,noscript,nav,footer,header,aside,button,form,iframe,svg').remove()
  c.find('br').replaceWith('\n')
  c.find(BLOCK_SEL).after('\n\n')
  return c
    .text()
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 正文抽取:优先命中选择器(article/main/#content/.content),兜底整个 body */
export function extractBody($: cheerio.CheerioAPI, selectors: string[]): string {
  for (const sel of selectors) {
    const el = $(sel)
    if (el.length) {
      const text = domToText(el)
      if (text.length > 80) return text.slice(0, 100_000)
    }
  }
  /* 兜底:整个 body(同样保留段落) */
  return domToText($('body')).slice(0, 50_000)
}
