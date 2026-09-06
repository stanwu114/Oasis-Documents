import { randomUUID } from 'node:crypto'
import { getDb } from '../db'
import { getThumbnailsDir } from '../dataLocation'
import { deleteVectors } from '../lancedb'
import { ftsUpsert, ftsDelete } from '../fts'
import { extractContent, titleFromPath } from './extractor'
import { sha256File } from '../organizer/hasher'
import { statFile, fingerprintHit } from '../fingerprint'
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
       thumbnail_path, tags, meta, created_at, updated_at, indexed_at, needs_reindex, file_mtime)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)
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
        /* N02：stat 预检——(path, size, mtime) 与库内一致 → 文件未变，
           直接跳过（不读文件内容、不算哈希），消灭启动全量重读盘 */
        const st = await statFile(path)
        if (!st) throw new Error('文件不可访问')
        if (fingerprintHit(path, st)) {
          skipped++
          if (sessionStarted) reportIndexResult('skip')
          done++
          if (sessionStarted) tickIndexSession()
          continue
        }

        /* N01：哈希只算一次，作为参数传给提取器（缩略图命名复用） */
        const hash = await sha256File(path)
        const existing = pathRow.get(path) as { id: string; hash: string | null } | undefined
        if (existing && existing.hash === hash) {
          skipped++
          if (sessionStarted) reportIndexResult('skip')
          /* 回写 mtime，下次启动走预检快速路径 */
          db.prepare(`UPDATE contents SET file_mtime = ?, file_size = ? WHERE id = ?`).run(st.mtimeMs, st.size, existing.id)
        } else if (existing) {
          /* R05：同路径内容变化 → 保留资产 ID 与用户标签，仅更新派生字段 */
          ensureSession()
          const ex = await extractContent(path, thumbs, hash)
          updateRevision(existing.id, ex, path, hash, st)
          ftsUpsert(existing.id, titleFromPath(path), ex.text)
          reportIndexResult('ok')
          if (enqueueEmbedding(existing.id, ex.category, ex, path)) enqueued++
          else {
            db.prepare(`UPDATE contents SET needs_reindex = 0 WHERE id = ?`).run(existing.id)
          }
        } else {
          ensureSession()
          const ex = await extractContent(path, thumbs, hash)
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
            now,
            /* N04：新内容先置 needs_reindex=1——向量持久化成功（flushTable markDone）
               才清零；中途退出由下次启动补扫自愈，永不静默丢向量 */
            1,
            st.mtimeMs
          )
          ftsUpsert(contentId, titleFromPath(path), ex.text)
          reportIndexResult('ok')
          if (enqueueEmbedding(contentId, ex.category, ex, path)) enqueued++
          else {
            /* 无嵌入价值（音频/图纸/空文本）——直接完成，不滞留待嵌入 */
            db.prepare(`UPDATE contents SET needs_reindex = 0 WHERE id = ?`).run(contentId)
          }
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

/**
 * N05：内容的唯一级联删除——SQLite 行 + FTS 全文 + 两张向量表 + 笔记。
 * 所有删除入口（watcher unlink / 移除监控目录 / 整理清理）统一走这里，
 * 杜绝派生数据残留（孤儿向量占检索名额、FTS 对账失配全量重建）。
 */
export function deleteContentCascade(contentId: string): void {
  const db = getDb()
  db.prepare(`DELETE FROM contents WHERE id = ?`).run(contentId)
  db.prepare(`DELETE FROM notes WHERE content_id = ?`).run(contentId)
  ftsDelete(contentId)
  void deleteVectors('image_vectors', contentId).catch(() => {})
  void deleteVectors('content_vectors', contentId).catch(() => {})
}

/** 按路径删除（watcher unlink 等） */
export function removeByPath(path: string): number {
  const db = getDb()
  const rows = db.prepare(`SELECT id FROM contents WHERE source_path = ?`).all(path) as { id: string }[]
  for (const r of rows) deleteContentCascade(r.id)
  return rows.length
}

/** R05：同路径内容新版本——保留资产 ID 与用户标签，更新派生字段 */
function updateRevision(
  contentId: string,
  ex: Awaited<ReturnType<typeof extractContent>>,
  path: string,
  hash: string,
  st?: { mtimeMs: number; size: number }
): void {
  const db = getDb()
  db.prepare(
    `UPDATE contents SET type = ?, title = ?, content = ?, mime_type = ?, file_size = ?,
       hash = ?, thumbnail_path = ?, meta = ?, updated_at = ?, indexed_at = ?,
       needs_reindex = CASE WHEN ? = 'image' OR COALESCE(?, '') != '' THEN 1 ELSE 0 END,
       file_mtime = ?
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
    ex.category,
    ex.text,
    st?.mtimeMs ?? null,
    contentId
  )
  /* 旧版本向量异步清理（重嵌前 embedding-pipeline 也会清） */
  void deleteVectors('image_vectors', contentId).catch(() => {})
  void deleteVectors('content_vectors', contentId).catch(() => {})
}
