import { readdir, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { getDb } from '../db'
import { sha256File, phashImage, hammingDistance } from './hasher'

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff', '.heic'])
const SKIP_DIRS = new Set(['node_modules', '.git', '.Trash', 'Library', 'App Library'])

export interface DuplicateScanResult {
  exactGroups: number
  nearImageGroups: number
  wastedBytes: number
}

export interface DuplicateGroupInfo {
  id: number
  kind: 'exact' | 'near-image'
  files: string[]
  wastedBytes: number
  keepPath: string | null
}

/** 递归扫描目录，计算哈希并写入 file_hashes 表 */
export async function scanAndHash(
  roots: string[],
  onProgress?: (scanned: number, current: string) => void
): Promise<void> {
  const db = getDb()
  const insert = db.prepare(`
    INSERT INTO file_hashes (path, sha256, phash, size, scanned_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      sha256 = excluded.sha256, phash = excluded.phash,
      size = excluded.size, scanned_at = excluded.scanned_at
  `)

  let scanned = 0
  const files: { path: string; size: number }[] = []

  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        await walk(full)
      } else if (entry.isFile()) {
        try {
          const s = await stat(full)
          if (s.size === 0) continue
          files.push({ path: full, size: s.size })
        } catch {
          /* 无权限等，跳过 */
        }
      }
    }
  }

  for (const root of roots) await walk(root)

  /* R01：better-sqlite3 的 transaction 不支持 async 回调（首个 await 后事务
     失控）；哈希计算是异步 IO，改为逐条 upsert——单条写入本身原子，
     失败只影响当前文件，不产生半提交事务 */
  const batchSize = 50
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize)
    for (const f of batch) {
      try {
        const sha = await sha256File(f.path)
        let phash: string | null = null
        if (IMAGE_EXTS.has(extname(f.path).toLowerCase())) {
          try {
            phash = await phashImage(f.path)
          } catch {
            /* 损坏图片，跳过 pHash */
          }
        }
        insert.run(f.path, sha, phash, f.size, Date.now())
        scanned++
        if (onProgress && scanned % 20 === 0) onProgress(scanned, f.path)
      } catch {
        /* 读取失败，跳过 */
      }
    }
  }
}

/** 基于哈希表生成重复组（exact: SHA 相同；near-image: pHash 汉明距离 ≤5） */
export function buildDuplicateGroups(nearThreshold = 5): DuplicateScanResult {
  const db = getDb()

  const result: DuplicateScanResult = { exactGroups: 0, nearImageGroups: 0, wastedBytes: 0 }

  /* R07：重建前先清掉 pending 旧组（确定性组键防重复追加） */
  db.prepare(`DELETE FROM duplicate_groups WHERE status = 'pending'`).run()

  /* --- 精确重复：按 sha256 分组 --- */
  const exactRows = db
    .prepare(
      `SELECT sha256, COUNT(*) as cnt, SUM(size) as total
       FROM file_hashes WHERE sha256 IS NOT NULL
       GROUP BY sha256 HAVING cnt > 1`
    )
    .all() as { sha256: string; cnt: number; total: number }[]

  const insertGroup = db.prepare(`
    INSERT INTO duplicate_groups (kind, hash_key, file_paths, wasted_bytes, keep_path, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `)
  const pathsByHash = db.prepare(`SELECT path, size FROM file_hashes WHERE sha256 = ?`)

  for (const row of exactRows) {
    const files = pathsByHash.all(row.sha256) as { path: string; size: number }[]
    // 推荐保留：路径最短（往往是最原始位置）
    const keep = [...files].sort((a, b) => a.path.length - b.path.length)[0]
    const wasted = row.total - keep.size
    insertGroup.run('exact', row.sha256, JSON.stringify(files.map((f) => f.path)), wasted, keep.path, Date.now())
    result.exactGroups++
    result.wastedBytes += wasted
  }

  /* --- 近似图片重复：pHash 聚类（同一 exact 组内跳过） --- */
  const imageRows = db
    .prepare(`SELECT path, phash, size FROM file_hashes WHERE phash IS NOT NULL`)
    .all() as { path: string; phash: string; size: number }[]

  const exactSets = new Set(
    exactRows.map((r) => r.sha256)
  )
  // 已在 exact 组中的文件不再参与 near 组
  const shaByPath = new Map(
    (db.prepare(`SELECT path, sha256 FROM file_hashes`).all() as { path: string; sha256: string }[]).map((r) => [
      r.path,
      r.sha256
    ])
  )

  const visited = new Set<number>()
  for (let i = 0; i < imageRows.length; i++) {
    if (visited.has(i)) continue
    if (exactSets.has(shaByPath.get(imageRows[i].path) ?? '')) continue

    const cluster = [i]
    for (let j = i + 1; j < imageRows.length; j++) {
      if (visited.has(j)) continue
      if (hammingDistance(imageRows[i].phash, imageRows[j].phash) <= nearThreshold) {
        cluster.push(j)
      }
    }
    if (cluster.length > 1) {
      cluster.forEach((idx) => visited.add(idx))
      const files = cluster.map((idx) => imageRows[idx])
      const keep = [...files].sort((a, b) => b.size - a.size)[0] // 保留分辨率最高的（size 代理）
      const wasted = files.reduce((acc, f) => acc + f.size, 0) - keep.size
      insertGroup.run(
        'near-image',
        imageRows[i].phash,
        JSON.stringify(files.map((f) => f.path)),
        wasted,
        keep.path,
        Date.now()
      )
      result.nearImageGroups++
      result.wastedBytes += wasted
    }
  }

  return result
}

/** 查询待处理的重复组（UI 展示用） */
export function listDuplicateGroups(status = 'pending'): DuplicateGroupInfo[] {
  const db = getDb()
  const rows = db
    .prepare(`SELECT id, kind, file_paths, wasted_bytes, keep_path FROM duplicate_groups WHERE status = ?`)
    .all(status) as { id: number; kind: string; file_paths: string; wasted_bytes: number; keep_path: string | null }[]
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as 'exact' | 'near-image',
    files: JSON.parse(r.file_paths) as string[],
    wastedBytes: r.wasted_bytes,
    keepPath: r.keep_path
  }))
}
