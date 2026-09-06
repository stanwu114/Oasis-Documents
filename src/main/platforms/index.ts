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
import { parseWithExternalService } from './external'
import { xiaohongshuPlugin } from './xiaohongshu'
import { douyinPlugin } from './douyin'
import { wechatPlugin } from './wechat'
import { csdnPlugin } from './csdn'

/* ================================================================
   L1 链接导入入口：分享文案 → 提取 URL → 识别平台 → 插件解析 → 统一入库
   不认识的平台走「通用网页」模式（og 标签 + 正文密度）
   ================================================================ */

export async function importLink(raw: string): Promise<{ platform: string; title: string; created: boolean; id: string; images: number; video: boolean }> {
  /* 1) 分享文本解析：整段文案中提取 URL + 清洗后的描述 + 话题 */
  const share = parseShareText(raw)
  if (!share.url) throw new Error('粘贴内容中未识别到链接（支持小红书/抖音/公众号/CSDN 分享文案）')

  /* 2) 平台识别与解析:外部解析服务优先(签名/风控由其处理),内置兜底 */
  const external = await parseWithExternalService(share.url)
  if (external) {
    const saved = await savePlatformContent(external)
    /* 已存在(重复导入):自动重抓更新图文,而不是提示后什么都不做 */
    if (!saved.created) {
      try {
        const r = await refreshPlatformContent(saved.id)
        return { platform: external.platform, title: external.title, created: false, id: saved.id, images: r.images, video: r.video }
      } catch {
        return { platform: external.platform, title: external.title, created: false, id: saved.id, images: 0, video: false }
      }
    }
    return { platform: external.platform, title: external.title, created: saved.created, id: saved.id, images: saved.images, video: saved.video }
  }
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
  if (!saved.created) {
    /* 同上:重复导入自动重抓(内置解析器路径) */
    try {
      const r = await refreshPlatformContent(saved.id)
      return { platform: content.platform, title: content.title, created: false, id: saved.id, images: r.images, video: r.video }
    } catch {
      return { platform: content.platform, title: content.title, created: false, id: saved.id, images: 0, video: false }
    }
  }
  return { platform: content.platform, title: content.title, created: saved.created, id: saved.id, images: saved.images, video: saved.video }
}

export const listPlugins = allPlugins

/** 重新抓取已收藏内容:更新正文/图片/视频/缩略图,保留资产 ID 与用户标签 */
export async function refreshPlatformContent(id: string): Promise<{ ok: boolean; images: number; video: boolean }> {
  const { getDb } = await import('../db')
  const { downloadAllImages, downloadVideo } = await import('./base')
  const db = getDb()
  const row = db
    .prepare(`SELECT id, url, platform, tags, meta FROM contents WHERE id = ? AND type = 'webpage'`)
    .get(id) as { id: string; url: string; platform: string; tags: string; meta: string } | undefined
  if (!row) throw new Error('收藏不存在')

  const external = await parseWithExternalService(row.url)
  const content = external ?? (findPluginFor(row.url) ? await (findPluginFor(row.url) as NonNullable<ReturnType<typeof findPluginFor>>).parseShareLink(row.url) : await parseGeneric(row.url))

  /* 图文视频重新落地 */
  const localImages = await downloadAllImages(content.imageUrls, content.platform)
  const videoPath = content.videoUrl ? await downloadVideo(content.videoUrl, content.platform) : null

  /* 标签保留用户已有一份并并入新解析 */
  let existingTags: string[] = []
  try {
    const v = JSON.parse(row.tags)
    if (Array.isArray(v)) existingTags = v.map(String)
  } catch { /* 空 */ }
  let oldMeta: Record<string, unknown> = {}
  try {
    oldMeta = JSON.parse(row.meta) as Record<string, unknown>
  } catch { /* 空 */ }

  db.prepare(
    `UPDATE contents SET title = ?, content = ?, thumbnail_path = ?, meta = ?, updated_at = ? WHERE id = ?`
  ).run(
    content.title || row.url,
    content.content,
    localImages[0] ?? null,
    JSON.stringify({
      ...oldMeta,
      imageUrls: localImages,
      remoteImages: content.imageUrls.slice(0, 20),
      videoPath: videoPath ?? oldMeta.videoPath ?? null,
      videoUrl: content.videoUrl ?? oldMeta.videoUrl ?? null
    }),
    Date.now(),
    row.id
  )
  db.prepare(`UPDATE contents SET tags = ? WHERE id = ?`).run(JSON.stringify(mergeTags(existingTags, content.tags)), row.id)

  /* 正文变了:FTS 与语义向量重嵌 */
  try {
    const { ftsUpsert } = await import('../fts')
    ftsUpsert(row.id, content.title, content.content)
  } catch { /* FTS 不可用 */ }
  try {
    const { enqueueTextEmbed } = await import('../indexer/embedding-pipeline')
    enqueueTextEmbed(row.id, `${content.title}\n\n${content.content}`)
  } catch { /* 模型未就绪,保持待补扫 */ }

  return { ok: true, images: localImages.length, video: Boolean(videoPath) }
}

/** 通用网页解析（og 标签 + 正文启发式） */
async function parseGeneric(url: string): Promise<{ platform: string; title: string; content: string; url: string; author?: string; tags: string[]; imageUrls: string[]; videoUrl?: string }> {
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
