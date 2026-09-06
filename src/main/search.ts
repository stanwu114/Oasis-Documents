import { getDb } from './db'
import { ftsSearch } from './fts'
import { getEmbedders, embedderReadiness, embedQuerySafe, embedImages, embedTextToImageSpace } from './embedder'
import { searchVectors } from './lancedb'
import {
  cosFromDistance,
  applyFloors,
  keywordScore,
  mergeById,
  type ScoredHit
} from './search-scoring'
import { tokenizeQuery, makeQuerySnippet } from '../shared/highlight'
import type { SearchResult } from '../shared/ipc'

/* ================================================================
   检索引擎 — 三模式对象严格分离
   以文搜文: 查询 → BGE(带检索指令) → content_vectors + 关键词(FTS/LIKE)
             —— 搜索对象仅文档(content_type 收窄,图片/收藏/RSS 不掺入)
   以文搜图: 查询 → CLIP 文本编码 → image_vectors + 文件名/OCR 关键词(仅图片)
   以图搜图: 图片 → CLIP 图片编码 → image_vectors(仅图片)
   质量策略（N20）:
   - 距离 → 余弦相似度,展示不再失真
   - 绝对底线 + 相对头部窗口:弱命中宁可不给,不凑满名额
   - 过量取回(3×)后按存在性水合:孤儿向量不再挤占结果名额
   - 标题关键词命中加权,可与语义命中竞争
   ================================================================ */

/* 相关性阈值(余弦标度)。语义通道好命中约 0.5–0.75;
   CLIP 中英跨模态相似度整体偏低,阈值相应降低。
   若召回偏少/偏杂,调这里(可用 scripts/eval-retrieval.mjs 验证) */
const TEXT_SEMANTIC_FLOOR = 0.3
const CLIP_TEXT_FLOOR = 0.16
const CLIP_SIM_FLOOR = 0.45 /* 以图搜图:同空间相似度高,门槛可抬高 */
const REL_WINDOW = 0.3

export async function searchByText(
  query: string,
  opts?: { limit?: number; type?: 'all' | 'document' }
): Promise<SearchResult[]> {
  const limit = opts?.limit ?? 20
  /* 以文搜文:默认仅文档——图片归以文搜图/以图搜图,收藏/RSS 不掺入 */
  const type = opts?.type ?? 'document'
  if (!query.trim()) return []
  const fetchN = limit * 3 /* 过量取回,水合时吸收孤儿向量与类型过滤损耗 */

  /* 双通道并行召回:文本语义(按 content_type 收窄候选) + 关键词(FTS/LIKE) */
  const [semHits, kwHits] = await Promise.all([
    semanticTextHits(
      query,
      fetchN,
      type === 'document' ? `content_type = 'document' OR content_type IS NULL` : undefined
    ).catch((e) => {
      console.warn('[search] 语义检索不可用:', e instanceof Error ? e.message : e)
      return [] as ScoredHit[]
    }),
    Promise.resolve(keywordHits(query, limit * 2, type === 'document' ? 'document' : undefined))
  ])

  return hydrate(mergeById([semHits, kwHits]), type, query).slice(0, limit)
}

export async function searchImagesByText(query: string, limit = 20): Promise<SearchResult[]> {
  if (!query.trim()) return []
  /* N20:CLIP 通道 + 文件名/OCR 关键词通道并行——
     "架构图" 要能命中 "系统架构图.png",光靠 CLIP 中文跨模态不够 */
  const [clip, kw] = await Promise.all([
    clipTextHits(query, limit * 3).catch(() => [] as ScoredHit[]),
    Promise.resolve(keywordHits(query, limit * 2, 'image'))
  ])
  return hydrate(mergeById([clip, kw]), 'image', query).slice(0, limit)
}

export async function searchByImage(imagePath: string, limit = 20): Promise<SearchResult[]> {
  const qvec = await embedImages([imagePath])
  const rows = await searchVectors('image_vectors', qvec[0], limit * 3)
  const hits = applyFloors(
    rows.map((r) => ({ id: r.contentId, score: cosFromDistance(r.distance) })),
    CLIP_SIM_FLOOR,
    REL_WINDOW
  )
  return hydrate(hits, 'image').slice(0, limit)
}

/* ---- 内部 ---- */

async function semanticTextHits(query: string, fetchN: number, where?: string): Promise<ScoredHit[]> {
  const { vectors } = await embedQuerySafe(query)
  const rows = await searchVectors('content_vectors', vectors[0], fetchN, where)
  return applyFloors(
    rows.map((r) => ({ id: r.contentId, score: cosFromDistance(r.distance) })),
    TEXT_SEMANTIC_FLOOR,
    REL_WINDOW
  )
}

async function clipTextHits(query: string, fetchN: number): Promise<ScoredHit[]> {
  const qvec = await embedTextToImageSpace(query)
  const rows = await searchVectors('image_vectors', qvec, fetchN)
  return applyFloors(
    rows.map((r) => ({ id: r.contentId, score: cosFromDistance(r.distance) })),
    CLIP_TEXT_FLOOR,
    REL_WINDOW
  )
}

/**
 * 关键词通道:FTS5(不可用回退 LIKE)→ 标题命中加权打分。
 * FTS 里的孤儿行(内容已删但索引未清)在此按存在性自然过滤。
 */
function keywordHits(query: string, limit: number, type?: 'image' | 'file' | 'webpage' | 'document'): ScoredHit[] {
  const db = getDb()
  const q = query.trim().toLowerCase()

  const ftsIds = ftsSearch(query, limit * 2)
  let ids: string[]
  if (ftsIds) {
    ids = ftsIds
  } else {
    const like = `%${query.replace(/[%_]/g, '')}%`
    ids = (
      db
        .prepare(`SELECT id FROM contents WHERE (title LIKE ? OR content LIKE ? OR ocr_text LIKE ?) LIMIT ?`)
        .all(like, like, like, limit * 2) as { id: string }[]
    ).map((r) => r.id)
  }

  const rowStmt = db.prepare(`SELECT title, type FROM contents WHERE id = ?`)
  const seen = new Set<string>()
  const hits: { id: string; titleHit: boolean }[] = []

  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    const row = rowStmt.get(id) as { title: string; type: string } | undefined
    if (!row) continue /* FTS 孤儿行 */
    if (type && row.type !== type) continue
    hits.push({ id, titleHit: row.title.toLowerCase().includes(q) })
  }


  /* 标题命中优先排序(同组内保持 FTS 位次),再统一计位次衰减——
     否则标题命中可能因 FTS 排位靠后被衰减到强语义命中之下 */
  const ordered = [...hits.filter((h) => h.titleHit), ...hits.filter((h) => !h.titleHit)]
  return ordered.map((h, i) => ({ id: h.id, score: keywordScore(i, ordered.length, h.titleHit) })).slice(0, limit)
}

/** content_id → SearchResult（标题、摘要、来源、缩略图;不存在的内容自然过滤）。
 *  query 用于摘要定位:窗口围绕命中词元截取(Everything 式,命中处可见) */
function hydrate(
  hits: ScoredHit[],
  type?: 'all' | 'image' | 'file' | 'webpage' | 'document',
  query?: string
): SearchResult[] {
  if (hits.length === 0) return []
  const tokens = query ? tokenizeQuery(query) : []
  const db = getDb()
  const stmt = db.prepare(
    `SELECT id, type, title, content, source_path, thumbnail_path, url, ocr_text, created_at FROM contents WHERE id = ?`
  )
  const out: SearchResult[] = []
  for (const h of hits) {
    const row = stmt.get(h.id) as
      | {
          id: string
          type: string
          title: string
          content: string
          source_path: string | null
          thumbnail_path: string | null
          url: string | null
          ocr_text: string
          created_at: number
        }
      | undefined
    if (!row) continue /* 孤儿向量/已删内容 */
    if (type && type !== 'all' && row.type !== type) continue
    out.push({
      id: row.id,
      title: row.title || (row.source_path?.split('/').pop() ?? '未命名'),
      snippet: makeQuerySnippet(row.content || row.ocr_text, tokens),
      type: row.type as SearchResult['type'],
      sourcePath: row.source_path ?? undefined,
      thumbnailPath: row.thumbnail_path ?? undefined,
      url: row.url ?? undefined,
      score: Number(h.score.toFixed(4)),
      createdAt: row.created_at
    })
  }
  return out
}

/* 检查嵌入引擎就绪状态（N12：真实状态而非硬编码） */
export function embedderStatus(): { textReady: boolean; imageReady: boolean; provider: string } {
  const { text } = getEmbedders()
  const ready = embedderReadiness()
  return {
    textReady: ready.textReady,
    imageReady: ready.imageReady,
    provider: text.info.name
  }
}
