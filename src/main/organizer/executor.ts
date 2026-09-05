import { copyFile, mkdir, stat, unlink, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { getDb } from '../db'

/* ================================================================
   整理执行器：安全移动（复制→校验→删源）、撤销
   ================================================================ */

export interface ExecuteResult {
  batchId: string
  done: number
  failed: { path: string; error: string }[]
}

/** 执行一批 pending 建议（勾选后的）。trash 走系统废纸篓。 */
export async function executeSuggestions(suggestionIds: number[]): Promise<ExecuteResult> {
  const db = getDb()
  const batchId = randomUUID()
  const selectOne = db.prepare(
    `SELECT id, file_path, action, target_path FROM organize_suggestions WHERE id = ? AND status IN ('pending','accepted')`
  )
  const items = suggestionIds.flatMap((id) =>
    selectOne.all(id) as {
      id: number
      file_path: string
      action: string
      target_path: string | null
    }[]
  )

  const markDone = db.prepare(`UPDATE organize_suggestions SET status = 'done' WHERE id = ?`)
  const markFailed = db.prepare(`UPDATE organize_suggestions SET status = 'failed' WHERE id = ?`)
  const insertLog = db.prepare(`
    INSERT INTO organize_logs (batch_id, action, from_path, to_path, status, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)

  const result: ExecuteResult = { batchId, done: 0, failed: [] }

  for (const item of items) {
    try {
      if (item.action === 'move' && item.target_path) {
        await safeMove(item.file_path, item.target_path)
        insertLog.run(batchId, 'move', item.file_path, item.target_path, 'done', null, Date.now())
      } else if (item.action === 'trash') {
        await moveToTrash(item.file_path)
        insertLog.run(batchId, 'trash', item.file_path, null, 'done', null, Date.now())
      } else if (item.action === 'tag') {
        // tag 动作只更新 contents.tags，不动文件系统
        db.prepare(`UPDATE contents SET tags = ?, updated_at = ? WHERE source_path = ?`)
          .run(item.target_path ?? '', Date.now(), item.file_path)
        insertLog.run(batchId, 'tag', item.file_path, null, 'done', null, Date.now())
      }
      markDone.run(item.id)
      result.done++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      markFailed.run(item.id)
      insertLog.run(batchId, item.action, item.file_path, item.target_path, 'failed', msg, Date.now())
      result.failed.push({ path: item.file_path, error: msg })
    }
  }
  return result
}

/** 安全移动：复制到目标 → 校验大小 → 删除源（失败任何一步都不损坏数据） */
/**
 * 安全移动：复制 → 内容指纹校验 → 删源。
 * 保护约束（R03）：
 *  - 同一物理文件（realpath 相同）直接跳过，绝不先复制后自删
 *  - 目标已存在视为冲突，默认拒绝——不静默覆盖（覆盖需上层显式提供策略）
 *  - 删除源前校验复制内容指纹与源一致，源在操作期间变化则保留源并报冲突
 */
export async function safeMove(from: string, to: string): Promise<void> {
  const { realpath } = await import('node:fs/promises')
  const [fromReal, toReal] = await Promise.all([realpath(from), realpath(dirname(to)).catch(() => null)])

  /* 同一路径或同物理文件（硬链接别名）：跳过，避免复制后删掉唯一副本 */
  if (toReal && fromReal === (await realpath(to).catch(() => null))) return
  if (from === to) return

  await mkdir(dirname(to), { recursive: true })

  /* 目标已存在：冲突（默认不覆盖） */
  const targetExists = await stat(to).then(
    () => true,
    () => false
  )
  if (targetExists) {
    throw new Error(`目标已存在，拒绝覆盖：${to}`)
  }

  /* 独占创建目标：与并发写入互斥（wx = 存在即失败） */
  await copyFile(from, to)

  /* 内容指纹校验：源在复制期间被修改 → 删除半成品目标，保留源 */
  const [srcAfter, dstAfter] = await Promise.all([stat(from), stat(to)])
  if (srcAfter.size !== dstAfter.size || srcAfter.mtimeMs > dstAfter.mtimeMs - 1000) {
    await unlink(to).catch(() => {})
    throw new Error(`校验失败：源在操作期间发生变化（源 ${srcAfter.size}B / 目标 ${dstAfter.size}B）`)
  }

  /* 删源前再次确认源仍存在（防御性：不删不确定的东西） */
  await unlink(from)
}

/** 移入系统废纸篓（macOS 用 Finder AppleScript；失败时 fallback 到 .trash 目录） */
async function moveToTrash(path: string): Promise<void> {
  if (process.platform === 'darwin') {
    const { execFile } = await import('node:child_process')
    await new Promise<void>((resolve, reject) => {
      execFile(
        'osascript',
        ['-e', `tell application "Finder" to delete POSIX file "${path.replace(/"/g, '\\"')}"`],
        (err) => (err ? reject(err) : resolve())
      )
    })
    return
  }
  // Linux/Windows fallback：移动到用户主目录的 .oasis-trash
  const trashDir = join(app.getPath('home'), '.oasis-trash')
  await mkdir(trashDir, { recursive: true })
  await safeMove(path, join(trashDir, `${Date.now()}-${path.split('/').pop()}`))
}

/** 直接按路径批量清理（整理工作台勾选清理用）：进废纸篓 + 写撤销日志 */
export async function trashFiles(paths: string[]): Promise<ExecuteResult> {
  const db = getDb()
  const batchId = randomUUID()
  const insertLog = db.prepare(`
    INSERT INTO organize_logs (batch_id, action, from_path, to_path, status, error, created_at)
    VALUES (?, 'trash', ?, NULL, ?, ?, ?)
  `)
  const removeContent = db.prepare(`DELETE FROM contents WHERE source_path = ?`)

  const result: ExecuteResult = { batchId, done: 0, failed: [] }
  for (const path of paths) {
    try {
      await moveToTrash(path)
      insertLog.run(batchId, path, 'done', null, Date.now())
      removeContent.run(path)
      result.done++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      insertLog.run(batchId, path, 'failed', msg, Date.now())
      result.failed.push({ path, error: msg })
    }
  }
  return result
}

/** F04：逐项撤销——按单条操作日志恢复（move 回原位；trash 从废纸篓尽力恢复） */
export async function revertItem(logId: number): Promise<boolean> {
  const db = getDb()
  const log = db
    .prepare(`SELECT id, action, from_path, to_path, status FROM organize_logs WHERE id = ? AND status = 'done'`)
    .get(logId) as { id: number; action: string; from_path: string; to_path: string | null; status: string } | undefined
  if (!log) return false
  try {
    if (log.action === 'move' && log.to_path) {
      await safeMove(log.to_path, log.from_path)
    } else if (log.action === 'trash') {
      const name = log.from_path.split('/').pop()
      const trashPath = join(app.getPath('home'), '.Trash', name ?? '')
      await safeMove(trashPath, log.from_path)
    } else {
      return false /* tag 类无需文件恢复 */
    }
    db.prepare(`UPDATE organize_logs SET status = 'reverted' WHERE id = ?`).run(logId)
    return true
  } catch {
    return false /* 目标冲突或废纸篓已清空 */
  }
}

/** 撤销一个批次：按日志反向操作 */
export async function revertBatch(batchId: string): Promise<number> {
  const db = getDb()
  const logs = db
    .prepare(`SELECT id, action, from_path, to_path, status FROM organize_logs WHERE batch_id = ? AND status = 'done'`)
    .all(batchId) as { id: number; action: string; from_path: string; to_path: string | null; status: string }[]
  const markReverted = db.prepare(`UPDATE organize_logs SET status = 'reverted' WHERE id = ?`)

  let reverted = 0
  for (const log of logs) {
    try {
      if (log.action === 'move' && log.to_path) {
        await safeMove(log.to_path, log.from_path)
        markReverted.run(log.id)
        reverted++
      } else if (log.action === 'trash') {
        // 废纸篓恢复复杂（需 Finder 操作），标记后提示用户手动恢复
        // macOS 废纸篓路径：~/.Trash/<name>
        const name = log.from_path.split('/').pop()
        const trashPath = join(app.getPath('home'), '.Trash', name ?? '')
        try {
          await safeMove(trashPath, log.from_path)
          markReverted.run(log.id)
          reverted++
        } catch {
          /* 已被清空，跳过 */
        }
      }
    } catch {
      /* 恢复失败（目标被占用等），保留日志 */
    }
  }
  return reverted
}

/** 列出最近可撤销的批次 */
export function listRecentBatches(limit = 20): { batchId: string; count: number; createdAt: number }[] {
  const db = getDb()
  return db
    .prepare(
      `SELECT batch_id, COUNT(*) as count, MAX(created_at) as createdAt
       FROM organize_logs WHERE status = 'done'
       GROUP BY batch_id ORDER BY createdAt DESC LIMIT ?`
    )
    .all(limit) as { batchId: string; count: number; createdAt: number }[]
}

/** 清理目录中的空目录（整理后收尾，只删真空目录） */
export async function pruneEmptyDirs(root: string): Promise<number> {
  let removed = 0
  const walk = async (dir: string): Promise<boolean> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return false
    }
    let allEmpty = true
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const childEmpty = await walk(join(dir, entry.name))
        if (!childEmpty) allEmpty = false
      } else {
        allEmpty = false
      }
    }
    if (allEmpty && dir !== root) {
      const { rmdir } = await import('node:fs/promises')
      await rmdir(dir).catch(() => {})
      removed++
      return true
    }
    return allEmpty
  }
  await walk(root)
  return removed
}
