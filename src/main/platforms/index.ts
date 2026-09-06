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

async function parse(url: string, options: import('./base').ImportOptions): Promise<import('./base').PlatformContent> {
  options.signal?.throwIfAborted()
  options.onProgress?.({phase: 'parsing'})
  const plugin = findPluginFor(url)
  return plugin ? plugin.parseShareLink(url, options) : parseGeneric(url, options.signal)
}

// 串行化同一分享链接，避免重复点击并发下载和插入。
const imports = new Map<string, Promise<Awaited<ReturnType<typeof doImport>>>>()
export function importLink(raw: string, options: import('./base').ImportOptions = {}) {
  const share = parseShareText(raw)
  if (!share.url) throw new Error('粘贴内容中未识别到链接')
  const key = share.url
  const running = imports.get(key)
  if (running) return running
  const task = doImport(share, options).finally(() => imports.delete(key))
  imports.set(key, task)
  return task
}
async function doImport(share: ReturnType<typeof parseShareText>, options: import('./base').ImportOptions) {
  const content = await parse(share.url!, {...options, share})
  content.shareText = share.rawText
  content.shareCode = share.shareCode
  if (!content.title && share.text) content.title = share.text.slice(0, 60)
  if (!content.content) content.content = share.text
  content.tags = mergeTags(content.tags, share.hashtags)
  const saved = await savePlatformContent(content, options)
  return {platform: content.platform, title: content.title, ...saved}
}

export const listPlugins = allPlugins
export async function refreshPlatformContent(id: string, options: import('./base').ImportOptions = {}) {
  const {getDb} = await import('../db')
  const row = getDb().prepare(`SELECT url, meta FROM contents WHERE id = ? AND type = 'webpage'`).get(id) as {url: string; meta: string} | undefined
  if (!row) throw new Error('收藏不存在')
  let share: ReturnType<typeof parseShareText> | undefined
  try {
    const raw = JSON.parse(row.meta || '{}').shareText
    if (typeof raw === 'string') share = parseShareText(raw)
  } catch { /* 旧收藏没有分享原文 */ }
  const content = await parse(share?.url ?? row.url, {...options, share})
  return {ok: true, ...await savePlatformContent(content, {...options, existingId: id})}
}

/** 通用网页解析（og 标签 + 正文启发式） */
async function parseGeneric(url: string, signal?: AbortSignal): Promise<{ platform: string; title: string; content: string; url: string; author?: string; tags: string[]; imageUrls: string[]; videoUrl?: string }> {
  const { finalUrl, html } = await fetchPage(url, {signal})
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
