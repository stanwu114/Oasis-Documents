import { getDb } from '../db'
import { addVectors, deleteVectors, ensureVectorSpace, type VectorTable } from '../lancedb'
import { embedTextsSafe, embedImages, embedderReadiness, activeImageVectorSpace } from '../embedder'
import type { FileCategory } from '../../shared/classify'
import type { ExtractResult } from './extractor'

/* ================================================================
   嵌入管线：入库后的异步补充
   - 并发 6（ONNX 会话内已限线程），推理经 RunMutex 串行化
   - 向量写入走批量缓冲（≥32 条或 5 秒 flush）合并事务——
     逐条 add 会在 LanceDB 积累数千小事务，写入越来越慢直至挂起
   - 队列排空时 flush + compact
   ================================================================ */

interface Job {
  contentId: string
  kind: 'image' | 'text'
  payload: string /* 图片路径或全文 */
  meta?: { width?: number; height?: number; contentType?: string }
}

const MAX_ACTIVE = 6
let active = 0
const waiting: Job[] = []

/* ---- 向量批量写入缓冲 ---- */
type VectorRecord = { id: string; content_id: string; vector: number[]; [k: string]: unknown }
interface WriteBuffer {
  adds: VectorRecord[]
  deleteIds: Set<string>
}
const buffers = new Map<VectorTable, WriteBuffer>()
let flushTimer: NodeJS.Timeout | null = null
let flushing = false

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushAll()
  }, 5000)
}

function bufferWrite(table: VectorTable, records: VectorRecord[]): void {
  const buf = buffers.get(table) ?? { adds: [], deleteIds: new Set<string>() }
  /* 同内容重嵌：清掉缓冲里旧记录，登记删除 */
  const newIds = new Set(records.map((r) => String(r.content_id)))
  buf.adds = buf.adds.filter((r) => !newIds.has(String(r.content_id)))
  for (const id of newIds) buf.deleteIds.add(id)
  buf.adds.push(...records)
  buffers.set(table, buf)
  if (buf.adds.length >= 32) void flushTable(table)
  else scheduleFlush()
}

async function flushTable(table: VectorTable): Promise<void> {
  const buf = buffers.get(table)
  if (!buf || (buf.adds.length === 0 && buf.deleteIds.size === 0)) return
  buffers.delete(table)
  if (flushing) {
    /* 避免并发 flush 交错事务：放回缓冲稍后重试 */
    buffers.set(table, buf)
    scheduleFlush()
    return
  }
  flushing = true
  const db = getDb()
  const markDone = db.prepare(`UPDATE contents SET needs_reindex = 0, indexed_at = ? WHERE id = ?`)
  const markPending = db.prepare(`UPDATE contents SET needs_reindex = 1 WHERE id = ?`)
  try {
    for (const cid of buf.deleteIds) {
      await deleteVectors(table, cid)
    }
    let rebuilt = false
    if (buf.adds.length > 0) {
      const r = await addVectors(table, buf.adds)
      rebuilt = r.rebuilt
    }
    /* R14：向量真实持久化成功后才标记完成——不再在入缓冲时就宣告成功 */
    for (const rec of buf.adds) markDone.run(Date.now(), String(rec.content_id))
    /* R16：表因损坏被重建（历史向量丢失）→ 该空间全部内容标记待补扫 */
    if (rebuilt) {
      console.warn(`[embed-pipeline] ${table} 已重建，触发该空间全量补扫`)
      db.prepare(
        table === 'image_vectors'
          ? `UPDATE contents SET needs_reindex = 1 WHERE type = 'image' AND source_path IS NOT NULL`
          : `UPDATE contents SET needs_reindex = 1 WHERE type != 'image' AND source_path IS NOT NULL AND COALESCE(content,'') != ''`
      ).run()
    }
  } catch (err) {
    console.warn('[embed-pipeline] flush 失败:', err instanceof Error ? err.message : err)
    for (const r of buf.adds) markPending.run(String(r.content_id))
  } finally {
    flushing = false
  }
}

export async function flushAll(): Promise<void> {
  for (const t of [...buffers.keys()]) await flushTable(t)
}

/** 队列彻底排空时：flush 全部缓冲（必须，数据安全），compact 火后不管（带超时） */
async function drainAndCompact(): Promise<void> {
  await flushAll()
  /* compact 不在关键路径：与后续写入可能锁冲突挂起，超时静默放弃 */
  void Promise.race([
    (async () => {
      const { optimizeTable } = await import('../lancedb')
      await optimizeTable('content_vectors')
      await optimizeTable('image_vectors')
    })(),
    new Promise((resolve) => setTimeout(resolve, 30_000))
  ]).catch(() => undefined)
}

/** 入库后调用：图片或文本进入嵌入队列（fire-and-forget）；返回是否入队 */
export function enqueueEmbedding(
  contentId: string,
  category: FileCategory,
  extract: ExtractResult,
  sourcePath?: string
): boolean {
  if (category === 'image') {
    if (!sourcePath) return false
    waiting.push({ contentId, kind: 'image', payload: sourcePath, meta: { width: extract.width, height: extract.height } })
  } else {
    const text = extract.text.trim()
    if (text.length < 8) return false /* 空文档无嵌入价值 */
    waiting.push({ contentId, kind: 'text', payload: text, meta: { contentType: 'document' } })
  }
  pump()
  return true
}

/** 补扫：模型下载后，把历史上跳过的 needs_reindex 内容收编进队列（带进度会话）。
 *  R15：持续翻页直至取完；N14：模型不就绪的行 10 分钟内不再反复取出 */
export function reindexPending(pageSize = 500): number {
  const db = getDb()
  const ready = embedderReadiness()
  if (!ready.textReady && !ready.imageReady) return 0

  let queued = 0
  for (;;) {
    const rows = db
      .prepare(
        `SELECT id, type, source_path, content FROM contents
         WHERE needs_reindex = 1
           AND (
             json_extract(COALESCE(meta,'{}'), '$.last_attempt') IS NULL
             OR CAST(json_extract(COALESCE(meta,'{}'), '$.last_attempt') AS INTEGER) < ?
           )
         LIMIT ?`
      )
      .all(Date.now() - 10 * 60_000, pageSize) as { id: string; type: string; source_path: string | null; content: string }[]
    /* N14：翻页前标记本批 last_attempt，防同一批无限循环 */
    if (rows.length > 0) {
      const mark = db.prepare(
        `UPDATE contents SET meta = json_set(COALESCE(meta,'{}'), '$.last_attempt', ?) WHERE id = ?`
      )
      for (const r of rows) mark.run(Date.now(), r.id)
    }
    if (rows.length === 0) break

    let pageQueued = 0
    for (const r of rows) {
      if (r.type === 'image') {
        if (r.source_path && ready.imageReady) {
          waiting.push({ contentId: r.id, kind: 'image', payload: r.source_path })
          queued++
          pageQueued++
        }
        /* N14：图片模型不可用 → 跳过（不改状态；SQL 侧已用 meta.last_attempt 节流见下） */
      } else if (r.content?.trim() && ready.textReady) {
        waiting.push({ contentId: r.id, kind: 'text', payload: r.content, meta: { contentType: 'document' } })
        queued++
        pageQueued++
      }
    }

    if (pageQueued === 0 && rows.length < pageSize) break
    if (pageQueued === 0) {
      /* 整页都不可执行：退出避免死循环（全部为不可处理类型） */
      break
    }
    if (rows.length < pageSize) break
  }
  if (queued > 0) {
    /* 补扫即向量化会话：直接从嵌入阶段开始显示进度 */
    void import('../import-progress').then((m) => m.beginEmbeddingSession(queued))
    pump()
  }
  return queued
}

/** R19：平台收藏/RSS 等非文件内容进入文本嵌入队列 */
export function enqueueTextEmbed(contentId: string, text: string): boolean {
  const t = text.trim()
  if (t.length < 8) return false
  if (!embedderReadiness().textReady) {
    getDb().prepare(`UPDATE contents SET needs_reindex = 1 WHERE id = ?`).run(contentId)
    return false
  }
  waiting.push({ contentId, kind: 'text', payload: t, meta: { contentType: 'webpage' } })
  pump()
  return true
}

/** 队列长度（UI 状态展示用） */
export function embeddingQueueSize(): number {
  return waiting.length + active
}

/* ---- 内部：极简并发闸门 ---- */
function pump(): void {
  while (active < MAX_ACTIVE && waiting.length > 0) {
    const job = waiting.shift() as Job
    active++
    void runJob(job)
      .catch((e) => console.warn('[embed-pipeline] 任务失败:', e instanceof Error ? e.message : e))
      .finally(() => {
        active--
        if (waiting.length === 0 && active === 0) {
          /* 队列彻底排空：flush 后通知收敛（compact 已移出关键路径） */
          console.log('[embed-pipeline] 队列排空，flush + 收敛')
          void flushAll()
            .catch((e) => console.warn('[embed-pipeline] flush 失败:', e instanceof Error ? e.message : e))
            .finally(() => {
              void drainAndCompact()
              void import('../import-progress').then((m) => m.settleEmbeddingSession())
            })
        }
        pump()
      })
  }
}

async function runJob(job: Job): Promise<void> {
  const db = getDb()
  const markDone = db.prepare(`UPDATE contents SET needs_reindex = 0, indexed_at = ? WHERE id = ?`)
  const markPending = db.prepare(`UPDATE contents SET needs_reindex = 1 WHERE id = ?`)

  try {
    if (job.kind === 'image') {
      const { imageReady } = embedderReadiness()
      if (!imageReady) {
        markPending.run(job.contentId)
        return
      }
      const vectors = await withTimeout(embedImages([job.payload]), 60_000)
      /* 向量空间身份校验:中英 CLIP 切换后旧空间向量不兼容(同 512 维,
         维度守卫抓不住)→ drop 表重建,全部图片标记待重嵌。
         本任务的向量随后写入新空间表,历史图片由补扫收敛 */
      if (await ensureVectorSpace('image_vectors', activeImageVectorSpace())) {
        db.prepare(`UPDATE contents SET needs_reindex = 1 WHERE type = 'image' AND source_path IS NOT NULL`).run()
      }
      bufferWrite('image_vectors', [
        {
          id: `${job.contentId}:img`,
          content_id: job.contentId,
          vector: vectors[0],
          kind: 'image',
          width: job.meta?.width ?? 0,
          height: job.meta?.height ?? 0,
          created_at: Date.now()
        }
      ])
      /* F02：图片 OCR（macOS Vision）——识别文字进全文索引 + 语义索引，
         让截图/票据可被"图中文字"搜到；失败不影响向量结果 */
      try {
        const { ocrImage, ocrAvailable } = await import('../ocr')
        if (ocrAvailable()) {
          const text = await withTimeout(ocrImage(job.payload), 45_000)
          if (text.trim().length > 1) {
            const db2 = getDb()
            db2.prepare(`UPDATE contents SET ocr_text = ? WHERE id = ?`).run(text.slice(0, 100_000), job.contentId)
            const { ftsUpsert } = await import('../fts')
            const title = (db2.prepare(`SELECT title FROM contents WHERE id = ?`).get(job.contentId) as { title: string } | undefined)?.title ?? ''
            ftsUpsert(job.contentId, title, text)
            /* OCR 文本同时进语义索引（text 空间）；
               N17：级联任务同步追加 embedTotal，完成报告计数不失真 */
            if (enqueueTextEmbed(job.contentId, text)) {
              void import('../import-progress').then((m) => m.addEmbedTotal(1))
            }
          }
        }
      } catch {
        /* OCR 失败静默：图片向量已成功 */
      }
    } else {
      const { textReady } = embedderReadiness()
      if (!textReady) {
        markPending.run(job.contentId)
        return
      }
      const chunks = chunkText(job.payload)
      if (chunks.length === 0) return
      const { vectors, usedProvider } = await withTimeout(embedTextsSafe(chunks.map((c) => c.text)), 120_000)
      bufferWrite(
        'content_vectors',
        chunks.map((c, i) => ({
          id: `${job.contentId}:${c.index}`,
          content_id: job.contentId,
          vector: vectors[i],
          chunk_index: c.index,
          snippet: c.text.slice(0, 200),
          embed_source: usedProvider,
          content_type: job.meta?.contentType ?? 'document',
          created_at: Date.now()
        }))
      )
    }
    /* R14：成功状态由 flushTable 持久化确认后统一标记，
       此处只上报处理结果统计 */
    void import('../import-progress').then((m) => m.reportEmbedResult('ok'))
  } catch (err) {
    /* 失败分类：格式解码类（HEIC 等 sharp 无法处理）是永久性失败，标记完成并
       记录错误，避免每次启动补扫都无限重试；暂时性错误（超时/API）保留重试 */
    const msg = err instanceof Error ? err.message : String(err)
    const permanent = /heif|HEIC|decode|unsupported|premature|Vips|bad seek|corrupt/i.test(msg)
    if (permanent) {
      markDone.run(Date.now(), job.contentId)
      const db2 = getDb()
      db2
        .prepare(`UPDATE contents SET meta = json_set(COALESCE(meta,'{}'), '$.embedError', ?) WHERE id = ?`)
        .run(msg.slice(0, 200), job.contentId)
    } else {
      markPending.run(job.contentId)
    }
    void import('../import-progress').then((m) => m.reportEmbedResult('fail', err))
    throw err
  } finally {
    /* 无论成败都推进导入会话进度 */
    const { tickEmbedSession } = await import('../import-progress')
    tickEmbedSession()
  }
}

/** 推理超时兜底：单个任务挂起（模型死锁等）时放弃并标记待重试，进度不卡死 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`嵌入超时(${ms / 1000}s)`)), ms)
    })
  ])
}

/** 文本切片：段落聚合，每片 ≤400 字，片间 40 字重叠保语义连续 */
export function chunkText(text: string, maxLen = 400, overlap = 40): { index: number; text: string }[] {
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!clean) return []

  /* 先按段落聚合 */
  const paras = clean.split(/\n{1,}/).map((p) => p.trim()).filter(Boolean)
  const chunks: string[] = []
  let buf = ''
  for (const para of paras) {
    let rest = para
    /* 超长段落硬切（带重叠） */
    while (rest.length > maxLen) {
      if (buf) {
        chunks.push(buf)
        buf = ''
      }
      chunks.push(rest.slice(0, maxLen))
      rest = rest.slice(maxLen - overlap)
    }
    if ((buf ? buf.length + 1 : 0) + rest.length > maxLen) {
      if (buf) chunks.push(buf) /* N13：空 buf 不产生空片 */
      buf = rest
    } else {
      buf = buf ? `${buf}\n${rest}` : rest
    }
  }
  if (buf) chunks.push(buf)

  return chunks.slice(0, 64).map((t, i) => ({ index: i, text: t })) /* 单文档最多 64 片 */
}
