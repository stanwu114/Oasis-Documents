import { getDb } from './db'
import { ftsSearch } from './fts'
import { getEmbedders, embedTextsSafe, embedImages, embedTextToImageSpace } from './embedder'
import type { SearchResult } from '../shared/ipc'

/* ================================================================
   检索引擎 — 三路检索统一入口
   以文搜文: 查询 → 文本嵌入 → content_vectors (语义空间)
   以文搜图: 查询 → CLIP 文本编码 → image_vectors (CLIP 空间)
   以图搜图: 图片 → CLIP 图片编码 → image_vectors
   辅以 SQLite 关键词 LIKE（向量库不可用时的兜底 + 混合召回）
   ================================================================ */

interface RawHit {
  id: string
  score: number
}

export async function searchByText(
  query: string,
  opts?: { limit?: number; type?: 'all' | 'image' | 'file' | 'webpage' }
): Promise<SearchResult[]> {
  const limit = opts?.limit ?? 20
  if (!query.trim()) return []

  /* 1) 语义向量路 */
  const semantic = await semanticTextSearch(query, limit).catch((e) => {
    console.warn('[search] 语义检索不可用，回退关键词:', e instanceof Error ? e.message : e)
    return [] as RawHit[]
  })

  /* 2) 关键词路（标题/正文/OCR） */
  const keyword = keywordSearch(query, limit)

  /* 3) 合并去重：语义优先，关键词补位，加权融合 */
  const merged = mergeHits([semantic, keyword], limit)
  return hydrate(merged, opts?.type)
}

export async function searchImagesByText(query: string, limit = 20): Promise<SearchResult[]> {
  if (!query.trim()) return []
  let hits: RawHit[] = []
  try {
    const qvec = await embedTextToImageSpace(query)
    hits = await queryLanceByContentIds('image_vectors', qvec, limit)
  } catch (e) {
    console.warn('[search] CLIP 文本编码不可用，回退 OCR 关键词:', e instanceof Error ? e.message : e)
    hits = keywordSearch(query, limit, 'image')
  }
  return hydrate(hits, 'image')
}

export async function searchByImage(imagePath: string, limit = 20): Promise<SearchResult[]> {
  let hits: RawHit[] = []
  const qvec = await embedImages([imagePath])
  hits = await queryLanceByContentIds('image_vectors', qvec[0], limit)
  return hydrate(hits, 'image')
}

/* ---- 内部 ---- */

async function semanticTextSearch(query: string, limit: number): Promise<RawHit[]> {
  const { vectors } = await embedTextsSafe([query])
  return queryLanceByContentIds('content_vectors', vectors[0], limit)
}

/** LanceDB 向量检索 → content_id + score */
async function queryLanceByContentIds(
  table: 'image_vectors' | 'content_vectors',
  vector: number[],
  limit: number
): Promise<RawHit[]> {
  const { searchVectors } = await import('./lancedb')
  const rows = await searchVectors(table, vector, limit)
  return rows.map((r) => ({ id: r.contentId, score: r.score }))
}

/** 关键词路：FTS5 全文检索（中文 bigram）优先，回退 LIKE；
 *  覆盖本地内容 + 收藏；RSS 条目（标题/摘要）进入统一搜索 */
function keywordSearch(query: string, limit: number, type?: 'image' | 'file' | 'webpage'): RawHit[] {
  const db = getDb()

  const ids: string[] = []

  /* 通道 1：FTS5（不可用返回 null 回退） */
  const ftsIds = ftsSearch(query, limit * 2)
  if (ftsIds) {
    ids.push(...ftsIds)
  } else {
    /* 回退：LIKE */
    const like = `%${query.replace(/[%_]/g, '')}%`
    ids.push(
      ...(
        db
          .prepare(`SELECT id FROM contents WHERE (title LIKE ? OR content LIKE ? OR ocr_text LIKE ?) LIMIT ?`)
          .all(like, like, like, limit * 2) as { id: string }[]
      ).map((r) => r.id)
    )
  }

  /* 按类型过滤 + 去重保序 */
  const typeStmt = type
    ? db.prepare(`SELECT type FROM contents WHERE id = ?`)
    : null
  const seen = new Set<string>()
  const filtered: string[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    if (typeStmt) {
      const row = typeStmt.get(id) as { type: string } | undefined
      if (!row || row.type !== type) continue
    }
    filtered.push(id)
    if (filtered.length >= limit) break
  }

  /* R20：RSS 条目（标题/摘要）进入统一搜索 */
  const like = `%${query.replace(/[%_]/g, '')}%`
  const feedRows = db
    .prepare(
      `SELECT 'feed:' || id AS id FROM feed_items
       WHERE title LIKE ? OR summary LIKE ?
       ORDER BY published_at DESC LIMIT ?`
    )
    .all(like, like, Math.min(limit, 20)) as { id: string }[]

  const all: string[] = [...filtered, ...feedRows.map((r) => r.id)]
  return all.map((id, i) => ({ id, score: Math.max(0, Math.min(1, 1 - i / (limit * 2))) })) /* 线性衰减分，钳制 0–1 */
}

/** 多路命中合并：R21——同一内容的多切片命中聚合为一条结果
 *  （取最高分，不按切片数重复加分）；分数钳制 [0,1] 防负数/超百 */
function mergeHits(paths: RawHit[][], limit: number): RawHit[] {
  const combined = new Map<string, { id: string; score: number }>()
  for (const hits of paths) {
    for (const h of hits) {
      const prev = combined.get(h.id)
      if (prev) {
        prev.score = Math.max(prev.score, h.score) /* 同内容取最高，不叠加 */
      } else {
        combined.set(h.id, { id: h.id, score: h.score })
      }
    }
  }
  return [...combined.values()]
    .map((h) => ({ ...h, score: Math.max(0, Math.min(1, h.score)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/** content_id → SearchResult（标题、摘要、来源） */
function hydrate(hits: RawHit[], type?: 'all' | 'image' | 'file' | 'webpage'): SearchResult[] {
  if (hits.length === 0) return []
  const db = getDb()
  const stmt = db.prepare(`SELECT id, type, title, content, source_path, url, ocr_text, created_at FROM contents WHERE id = ?`)
  /* R20：feed: 前缀命中来自订阅条目 */
  const feedStmt = db.prepare(
    `SELECT f.id, f.title, f.summary AS content, f.url, s.title AS sub_title, f.published_at AS created_at
     FROM feed_items f JOIN subscriptions s ON s.id = f.subscription_id WHERE f.id = ?`
  )
  const out: SearchResult[] = []
  for (const h of hits) {
    if (h.id.startsWith('feed:')) {
      const feed = feedStmt.get(h.id.slice(5)) as
        | { id: string; title: string; content: string; url: string; sub_title: string; created_at: number }
        | undefined
      if (feed) {
        out.push({
          id: `feed:${feed.id}`,
          title: feed.title,
          snippet: makeSnippet(`${feed.sub_title} · ${feed.content}`),
          type: 'webpage',
          url: feed.url,
          score: Number(h.score.toFixed(4)),
          createdAt: feed.created_at
        })
      }
      continue
    }
    const row = stmt.get(h.id) as
      | { id: string; type: string; title: string; content: string; source_path: string | null; url: string | null; ocr_text: string; created_at: number }
      | undefined
    if (!row) continue
    if (type && type !== 'all' && row.type !== type) continue
    out.push({
      id: row.id,
      title: row.title || (row.source_path?.split('/').pop() ?? '未命名'),
      snippet: makeSnippet(row.content || row.ocr_text),
      type: row.type as SearchResult['type'],
      sourcePath: row.source_path ?? undefined,
      url: row.url ?? undefined,
      score: Number(h.score.toFixed(4)),
      createdAt: row.created_at
    })
  }
  return out
}

function makeSnippet(text: string, len = 120): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > len ? clean.slice(0, len) + '…' : clean
}

/* 检查嵌入引擎就绪状态（设置页/搜索前提示用） */
export function embedderStatus(): { textReady: boolean; imageReady: boolean; provider: string } {
  const { text } = getEmbedders()
  return {
    textReady: true,
    imageReady: true,
    provider: text.info.name
  }
}
