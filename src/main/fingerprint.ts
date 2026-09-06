import { stat } from 'node:fs/promises'
import { getDb } from './db'
import { sha256File } from './organizer/hasher'

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
 * 不一致或无记录 → 返回 null（调用方需全量哈希后 writeFingerprint 回写）
 */
export function fingerprintHit(path: string, st: FileStatInfo): string | null {
  const row = getDb()
    .prepare(`SELECT hash, file_size, file_mtime FROM contents WHERE source_path = ?`)
    .get(path) as { hash: string | null; file_size: number | null; file_mtime: number | null } | undefined
  if (!row || !row.hash) return null
  if (row.file_size === st.size && row.file_mtime === st.mtimeMs) return row.hash
  return null
}

/** 哈希并回写指纹（mtime 持久化，供下次预检） */
export async function hashWithFingerprint(path: string, st: FileStatInfo): Promise<string> {
  const hash = await sha256File(path)
  getDb()
    .prepare(`UPDATE contents SET file_mtime = ?, file_size = ? WHERE source_path = ? AND hash IS NOT NULL`)
    .run(st.mtimeMs, st.size, path)
  return hash
}
