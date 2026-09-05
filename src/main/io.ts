import * as cheerio from 'cheerio'
import { XMLParser } from 'fast-xml-parser'
import { readFile, writeFile } from 'node:fs/promises'
import { getDb } from './db'
import { importLink } from './platforms'
import { addSubscription } from './subscriptions/rss'

/* ================================================================
   F05：批量导入导出
   - Netscape 书签 HTML → 收藏（逐条走链接导入管线）
   - OPML → 订阅源
   - 自有 JSON：收藏/标签/来源 + 订阅/已读/星标（可再导入，不放大）
   ================================================================ */

export async function importBookmarks(html: string): Promise<{ added: number; failed: number }> {
  const $ = cheerio.load(html)
  let added = 0
  let failed = 0
  const links = $('a[href]').toArray()
  for (const a of links) {
    const href = $(a).attr('href')
    const title = $(a).text().trim()
    if (!href || !/^https?:\/\//.test(href)) continue
    try {
      const r = await importLink(`${title}\n${href}`) /* 文本含标题与链接，走分享文案解析 */
      if (r.created) added++
      else added++ /* 已存在视为成功导入（幂等） */
    } catch {
      failed++
    }
  }
  return { added, failed }
}

export async function importOpml(xml: string): Promise<{ added: number; failed: number }> {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })
  const doc = parser.parse(xml) as { opml?: { body?: unknown } }
  const outlines: unknown[] = []
  const collect = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const arr = Array.isArray(node) ? node : [node]
    for (const n of arr as Record<string, unknown>[]) {
      const type = n['@_type'] ?? n.type
      const url = n['@_xmlUrl'] ?? n.xmlUrl
      if (type === 'rss' && typeof url === 'string') outlines.push(url)
      const children = n.outline
      if (children) collect(children)
    }
  }
  collect(doc.opml?.body)
  let added = 0
  let failed = 0
  for (const url of [...new Set(outlines as string[])]) {
    try {
      await addSubscription(url)
      added++
    } catch {
      failed++
    }
  }
  return { added, failed }
}

interface ExportPayload {
  version: 1
  exportedAt: number
  contents: { title: string; url: string; platform: string | null; tags: string[]; createdAt: number }[]
  subscriptions: { title: string; feedUrl: string; siteUrl: string }[]
  feedStatus: { url: string; read: boolean; starred: boolean }[]
}

export async function exportJson(): Promise<string> {
  const db = getDb()
  const contents = (
    db.prepare(`SELECT title, url, platform, tags, created_at FROM contents WHERE url IS NOT NULL ORDER BY created_at`).all() as {
      title: string
      url: string
      platform: string | null
      tags: string
      created_at: number
    }[]
  ).map((r) => ({
    title: r.title,
    url: r.url,
    platform: r.platform,
    tags: safeArr(r.tags),
    createdAt: r.created_at
  }))
  const subscriptions = (
    db.prepare(`SELECT title, feed_url, site_url FROM subscriptions ORDER BY created_at`).all() as {
      title: string
      feed_url: string
      site_url: string
    }[]
  ).map((r) => ({ title: r.title, feedUrl: r.feed_url, siteUrl: r.site_url }))
  const feedStatus = (
    db.prepare(
      `SELECT f.url, CASE WHEN f.read=1 THEN 1 ELSE 0 END AS read, CASE WHEN f.starred=1 THEN 1 ELSE 0 END AS starred
       FROM feed_items f`
    ).all() as { url: string; read: number; starred: number }[]
  ).map((r) => ({ url: r.url, read: r.read === 1, starred: r.starred === 1 }))

  const payload: ExportPayload = {
    version: 1,
    exportedAt: Date.now(),
    contents,
    subscriptions,
    feedStatus
  }
  return JSON.stringify(payload, null, 2)
}

export async function importJson(json: string): Promise<{ contents: number; subscriptions: number }> {
  const payload = JSON.parse(json) as Partial<ExportPayload>
  const db = getDb()
  let contents = 0
  let subscriptions = 0

  for (const c of payload.contents ?? []) {
    if (!c.url) continue
    const exist = db.prepare(`SELECT 1 FROM contents WHERE url = ?`).get(c.url)
    if (exist) continue
    const { randomUUID } = await import('node:crypto')
    const id = randomUUID()
    const now = Date.now()
    db.prepare(
      `INSERT INTO contents (id, type, title, content, url, platform, tags, created_at, updated_at, indexed_at)
       VALUES (?, 'webpage', ?, '', ?, ?, ?, ?, ?, ?)`
    ).run(id, c.title ?? '', c.url, c.platform ?? null, JSON.stringify(c.tags ?? []), c.createdAt ?? now, now, now)
    contents++
  }

  for (const s of payload.subscriptions ?? []) {
    if (!s.feedUrl) continue
    try {
      await addSubscription(s.feedUrl)
      subscriptions++
    } catch {
      /* 单源失败继续 */
    }
  }

  /* 阅读状态回填（按 URL 匹配） */
  for (const f of payload.feedStatus ?? []) {
    db.prepare(`UPDATE feed_items SET read = ?, starred = ? WHERE url = ?`).run(f.read ? 1 : 0, f.starred ? 1 : 0, f.url)
  }
  return { contents, subscriptions }
}

function safeArr(json: string | null): string[] {
  try {
    const v = JSON.parse(json ?? '[]')
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

export async function readTextFile(path: string): Promise<string> {
  return readFile(path, 'utf8')
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, 'utf8')
}
