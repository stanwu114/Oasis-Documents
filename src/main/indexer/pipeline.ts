import { randomUUID } from 'node:crypto'
import { getDb } from '../db'
import { getThumbnailsDir } from '../dataLocation'
import { deleteVectors } from '../lancedb'
import { ftsUpsert, ftsDelete } from '../fts'
import { extractContent, titleFromPath } from './extractor'
import { sha256File } from '../organizer/hasher'
import { enqueueEmbedding } from './embedding-pipeline'

/* ================================================================
   索引管线：文件 → 哈希去重 → 内容提取 → contents 入库
   向量嵌入由 embedder 模块在入库后异步补（本期预留）
   ================================================================ */

export interface IndexProgress {
  current: string
  done: number
  total: number
  skipped: number
  failed: number
}

/* 系统垃圾/不可索引文件黑名单（其余全部入库，按六分类展示） */
const IGNORED_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])
const IGNORED_EXTS = new Set(['.part', '.crdownload', '.tmp', '.download', '.plist'])

/* 索引代际：删除监控目录时递增，进行中的索引批次检测到代际变化即中止，
   避免删除后旧批次继续把文件插回来 */
let indexEpoch = 0
export function abortRunningIndexBatches(): void {
  indexEpoch++
}

export function isSupportedFile(path: string): boolean {
  const lower = path.toLowerCase()
  const name = lower.slice(lower.lastIndexOf('/') + 1)
  if (IGNORED_NAMES.has(name)) return false
  const ext = lower.slice(lower.lastIndexOf('.'))
  if (IGNORED_EXTS.has(ext)) return false
  return ext.length > 1 && ext.length <= 6 /* 无扩展名或超长后缀不入库 */
}

/** 批量索引：新文件入库，已索引（同哈希）跳过（6 路并发重叠 I/O） */
export async function indexFiles(
  paths: string[],
  onProgress?: (p: IndexProgress) => void
): Promise<{ indexed: number; skipped: number; failed: number; aborted?: boolean }> {
  const db = getDb()
  const thumbs = getThumbnailsDir()

  const insert = db.prepare(`
    INSERT INTO contents
      (id, type, title, content, source_path, mime_type, file_size, hash,
       thumbnail_path, tags, meta, created_at, updated_at, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `)
  /* R04：按路径判重（同哈希的不同物理文件都要入库），同路径+同哈希跳过 */
  const pathRow = db.prepare(`SELECT id, hash FROM contents WHERE source_path = ?`)

  let done = 0, skipped = 0, failed = 0, enqueued = 0, aborted = false
  const total = paths.length
  const myEpoch = indexEpoch
  const { tickIndexSession, reportIndexResult } = await import('../import-progress')
  /* 懒启动会话：第一个真正的新文件出现才弹进度——重启后 watcher 重扫
     全部哈希命中跳过时，不该闪一个"导入完成"的空弹窗 */
  let sessionStarted = false
  const ensureSession = (): void => {
    if (sessionStarted) return
    sessionStarted = true
    void import('../import-progress').then((m) => m.beginIndexSession(total))
  }

  /* 6 路并发：哈希(流式读盘)、缩略图(sharp/ffmpeg)、文本提取互相重叠 */
  const CONCURRENCY = Math.min(6, Math.max(1, paths.length))
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      if (myEpoch !== indexEpoch) {
        aborted = true
        return
      }
      const i = cursor++
      if (i >= total) return
      const path = paths[i]
      try {
        const hash = await sha256File(path)
        const existing = pathRow.get(path) as { id: string; hash: string | null } | undefined
        if (existing && existing.hash === hash) {
          skipped++
          if (sessionStarted) reportIndexResult('skip')
        } else if (existing) {
          /* R05：同路径内容变化 → 保留资产 ID 与用户标签，仅更新派生字段 */
          ensureSession()
          const ex = await extractContent(path, thumbs)
          updateRevision(existing.id, ex, path, hash)
          ftsUpsert(existing.id, titleFromPath(path), ex.text)
          reportIndexResult('ok')
          if (enqueueEmbedding(existing.id, ex.category, ex, path)) enqueued++
        } else {
          ensureSession()
          const ex = await extractContent(path, thumbs)
          const now = Date.now()
          const contentId = randomUUID()
          insert.run(
            contentId,
            ex.category,
            titleFromPath(path),
            ex.text.slice(0, 500_000),
            path,
            ex.mimeType,
            ex.fileSize,
            hash,
            ex.thumbnailPath,
            JSON.stringify(ex.meta),
            now,
            now,
            now
          )
          ftsUpsert(contentId, titleFromPath(path), ex.text)
          reportIndexResult('ok')
          if (enqueueEmbedding(contentId, ex.category, ex, path)) enqueued++
        }
      } catch (err) {
        failed++
        reportIndexResult('fail', err)
      }
      done++
      if (sessionStarted) tickIndexSession()
      if (onProgress) {
        onProgress({ current: path, done, total, skipped, failed })
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  /* 全部跳过（重启重扫）且从未开启会话：不打扰用户 */
  if (!sessionStarted) {
    return { indexed: 0, skipped, failed }
  }
  const { endIndexSession } = await import('../import-progress')
  if (aborted) {
    endIndexSession(0) /* 会话终止，不计嵌入 */
    return { indexed: done - skipped - failed, skipped, failed, aborted: true }
  }
  endIndexSession(enqueued)
  return { indexed: done - skipped - failed, skipped, failed }
}

/** 删除内容（文件被移除时）：SQLite 记录 + 全文索引 + LanceDB 向量 */
export function removeByPath(path: string): number {
  const db = getDb()
  const rows = db.prepare(`SELECT id FROM contents WHERE source_path = ?`).all(path) as { id: string }[]
  const info = db.prepare(`DELETE FROM contents WHERE source_path = ?`).run(path)
  for (const r of rows) {
    ftsDelete(r.id)
    void deleteVectors('image_vectors', r.id).catch(() => {})
    void deleteVectors('content_vectors', r.id).catch(() => {})
  }
  return info.changes
}

/** R05：同路径内容新版本——保留资产 ID 与用户标签，更新派生字段 */
function updateRevision(
  contentId: string,
  ex: Awaited<ReturnType<typeof extractContent>>,
  path: string,
  hash: string
): void {
  const db = getDb()
  db.prepare(
    `UPDATE contents SET type = ?, title = ?, content = ?, mime_type = ?, file_size = ?,
       hash = ?, thumbnail_path = ?, meta = ?, updated_at = ?, indexed_at = ?, needs_reindex = 0
     WHERE id = ?`
  ).run(
    ex.category,
    titleFromPath(path),
    ex.text.slice(0, 500_000),
    ex.mimeType,
    ex.fileSize,
    hash,
    ex.thumbnailPath,
    JSON.stringify(ex.meta),
    Date.now(),
    Date.now(),
    contentId
  )
  /* 旧版本向量异步清理（重嵌前 embedding-pipeline 也会清） */
  void deleteVectors('image_vectors', contentId).catch(() => {})
  void deleteVectors('content_vectors', contentId).catch(() => {})
}
