import * as cheerio from 'cheerio'
import {
  extractMeta,
  extractBody,
  fetchPage,
  savePlatformContent,
  findPluginFor,
  registerPlugin,
  listPlugins as allPlugins
} from './base'
import { parseShareText } from './share-text'
import { mergeTags } from '../autotag'
import { xiaohongshuPlugin } from './xiaohongshu'
import { douyinPlugin } from './douyin'
import { wechatPlugin } from './wechat'
import { csdnPlugin } from './csdn'

/* ================================================================
   L1 链接导入入口：分享文案 → 提取 URL → 识别平台 → 插件解析 → 统一入库
   不认识的平台走「通用网页」模式（og 标签 + 正文密度）
   ================================================================ */

export async function importLink(raw: string): Promise<{ platform: string; title: string; created: boolean; id: string }> {
  /* 1) 分享文本解析：整段文案中提取 URL + 清洗后的描述 + 话题 */
  const share = parseShareText(raw)
  if (!share.url) throw new Error('粘贴内容中未识别到链接（支持小红书/抖音/公众号/CSDN 分享文案）')

  /* 2) 平台识别与解析 */
  const plugin = findPluginFor(share.url)
  const content = plugin ? await plugin.parseShareLink(share.url) : await parseGeneric(share.url)

  /* 3) 分享文案回填：口令码页面解析不到标题时用文案兜底；话题并入标签；文案并入正文 */
  if (share.text) {
    if (!content.title || /^(未命名|抖音视频|小红书笔记)/.test(content.title)) {
      content.title = share.text.slice(0, 60)
    }
    if (share.text.length > 3) {
      content.content = share.text + (content.content ? `\n\n${content.content}` : '')
    }
    if (share.hashtags.length > 0) {
      content.tags = mergeTags(content.tags, share.hashtags)
    }
  }

  const saved = await savePlatformContent(content)
  return { platform: content.platform, title: content.title, created: saved.created, id: saved.id }
}

export const listPlugins = allPlugins

/** 通用网页解析（og 标签 + 正文启发式） */
async function parseGeneric(url: string): Promise<{ platform: string; title: string; content: string; url: string; author?: string; tags: string[]; imageUrls: string[] }> {
  const { finalUrl, html } = await fetchPage(url)
  const $ = cheerio.load(html)
  const meta = extractMeta($)
  const host = new URL(finalUrl).hostname.replace(/^www\./, '')
  return {
    platform: host,
    title: meta.title,
    content: extractBody($, ['article', 'main', '#content', '.content']),
    url: finalUrl,
    tags: [],
    imageUrls: meta.image ? [meta.image] : []
  }
}

/* 注册平台插件 */
registerPlugin(xiaohongshuPlugin)
registerPlugin(douyinPlugin)
registerPlugin(wechatPlugin)
registerPlugin(csdnPlugin)
