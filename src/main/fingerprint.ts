import { stat } from 'node:fs/promises'
import { getDb } from './db'

/* ================================================================
   文件指纹缓存（复查 3.2-A）：唯一的哈希入口
   stat 预检：路径 + size + mtime 与库内一致 → 直接返回缓存哈希，
   不读文件内容（消灭启动全量重读盘，N02）
   ================================================================ */

export interface FileStatInfo {
  size: number
  mtimeMs: number
}

export async function statFile(path: string): Promise<FileStatInfo | null> {
  try {
    const s = await stat(path)
    return { size: s.size, mtimeMs: Math.floor(s.mtimeMs) }
  } catch {
    return null
  }
}

/**
 * stat 预检：库内 (path, size, mtime) 一致 → 未变化，返回缓存哈希；
 * 不一致或无记录 → 返回 null（调用方全量哈希后自行回写 file_mtime/file_size）
 */
export function fingerprintHit(path: string, st: FileStatInfo): string | null {
  const row = getDb()
    .prepare(`SELECT hash, file_size, file_mtime FROM contents WHERE source_path = ?`)
    .get(path) as { hash: string | null; file_size: number | null; file_mtime: number | null } | undefined
  if (!row || !row.hash) return null
  if (row.file_size === st.size && row.file_mtime === st.mtimeMs) return row.hash
  return null
}
