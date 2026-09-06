import * as lancedb from '@lancedb/lancedb'
import { getVectorDbPath } from './dataLocation'
import { getDb } from './db'

/* ================================================================
   LanceDB 向量存储（嵌入式，零服务进程）
   集合：
     image_vectors   — CLIP 图片向量（512 dim）+ OCR 文本
     content_vectors — 文本内容向量（BGE 或在线 API，维度随来源）
   安全模型：
     - 同表写互斥（add/delete/optimize 串行执行）——LanceDB 不支持
       进程内并发事务，并发写会导致清单与数据文件失配（Not found 损坏）
     - 损坏自愈：清单引用缺失文件时 drop 重建，数据由 needs_reindex 补扫恢复
   ================================================================ */

export type VectorTable = 'image_vectors' | 'content_vectors'

let dbConn: lancedb.Connection | null = null

export async function getLanceDb(): Promise<lancedb.Connection> {
  if (!dbConn) {
    dbConn = await lancedb.connect(getVectorDbPath())
  }
  return dbConn
}

const writeLocks = new Map<VectorTable, Promise<unknown>>()

/**
 * 向量空间身份校验(R12 维度守卫的补全):settings 里记录每张表所属空间。
 * 空间不兼容(中英 CLIP 切换:同为 512 维但语义空间不同,R12 的维度检查
 * 抓不住这种情况)→ drop 表重建。向量是可重建的派生数据,调用方检测到
 * 返回 true 后应标记 needs_reindex 全量补嵌(R16 同款补偿)。
 * @returns 是否发生了空间切换(表已重建)
 */
export async function ensureVectorSpace(table: VectorTable, space: string): Promise<boolean> {
  const key = `vector_space:${table}`
  const db = getDb()
  const read = () =>
    db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined
  const write = (v: string) =>
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, v)

  /* 无记录的存量库默认视为旧英文 CLIP 空间(升级用户)——
     否则首次写中文向量会漏掉 drop,造成中英向量混写 */
  const LEGACY = 'clip-vit-b32-en'
  const current = read()?.value ?? LEGACY
  if (current === space) {
    if (!read()) write(space) /* 首次记录当前空间 */
    return false
  }
  return withWriteLock(table, async () => {
    const cur = read()?.value ?? LEGACY /* 锁内复查,防并发双切 */
    if (cur === space) return false
    const conn = await getLanceDb()
    const names = await conn.tableNames()
    if (names.includes(table)) await conn.dropTable(table)
    write(space)
    console.warn(`[lancedb] 向量空间切换 ${cur} → ${space}，${table} 重建，历史向量待补嵌`)
    return true
  })
}

function withWriteLock<T>(table: VectorTable, task: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(table) ?? Promise.resolve()
  const result = prev.then(task, task)
  writeLocks.set(table, result.catch(() => undefined))
  return result
}

/** 损坏判定：清单引用缺失数据文件等 */
function isCorruptError(err: unknown): boolean {
  return /Not found|manifest|corrupt|Corrupt/i.test(err instanceof Error ? err.message : String(err))
}

/** 添加向量记录（表不存在则以本批记录建表；损坏自愈重建）。
 *  返回 rebuilt = 表因损坏被重建（历史向量已丢失，调用方应触发全量补扫）。
 *  R12 守卫：维度一致、数值有限、与表内已有维度兼容——不合格在写入前拒绝 */
export async function addVectors(
  tableName: VectorTable,
  records: { id: string; content_id: string; vector: number[]; [k: string]: unknown }[]
): Promise<{ rebuilt: boolean }> {
  if (records.length === 0) return { rebuilt: false }

  /* 写入前校验：同批维度一致、无 NaN/Infinity */
  const dim = records[0].vector.length
  if (dim === 0) throw new Error(`[lancedb] 拒绝写入：${tableName} 向量维度为 0`)
  for (const r of records) {
    if (r.vector.length !== dim) {
      throw new Error(`[lancedb] 拒绝写入：${tableName} 批内维度不一致（${r.vector.length} ≠ ${dim}）`)
    }
    for (const v of r.vector) {
      if (!Number.isFinite(v)) throw new Error(`[lancedb] 拒绝写入：${tableName} 含非有限数值（NaN/Infinity）`)
    }
  }

  return withWriteLock(tableName, async () => {
    const db = await getLanceDb()
    const names = await db.tableNames()
    if (names.includes(tableName)) {
      try {
        const table = await db.openTable(tableName)
        /* R12 空间守卫：只读采样比对表内已有维度——不符即拒绝写入，
           防止不同模型空间的向量混入同一张表（不重建、不降级，明确报错） */
        const sample = (await table.query().limit(1).toArray()) as Record<string, unknown>[]
        if (sample.length > 0) {
          const existing = sample[0].vector as number[] | { list?: number[] } | undefined
          const existingDim = Array.isArray(existing) ? existing.length : existing?.list?.length ?? 0
          if (existingDim > 0 && existingDim !== dim) {
            throw new Error(
              `[lancedb] 拒绝写入 ${tableName}：空间维度不兼容（表内 ${existingDim} ≠ 本批 ${dim}）——` +
                `请先在设置中切换回原模型，或清空重建该向量空间`
            )
          }
        }
        await table.add(records)
        return { rebuilt: false }
      } catch (err) {
        if (!isCorruptError(err)) throw err
        console.warn(`[lancedb] ${tableName} 损坏，重建表`)
        await db.dropTable(tableName)
      }
    }
    await db.createTable(tableName, records)
    return { rebuilt: true }
  })
}

/** 向量检索 → { contentId, distance }（按距离升序；原始距离直接返回，
    余弦换算与相关性下限由检索层 search-scoring 统一处理）。
    where: 可选 SQL 过滤(如 content_type = 'document'),在向量检索时同步收窄候选集 */
export async function searchVectors(
  tableName: VectorTable,
  queryVector: number[],
  limit = 20,
  where?: string
): Promise<{ contentId: string; distance: number }[]> {
  const db = await getLanceDb()
  const names = await db.tableNames()
  if (!names.includes(tableName)) return []

  const table = await db.openTable(tableName)
  const base = table.search(queryVector)
  const rows = (await (where ? base.where(where) : base).limit(limit).toArray()) as Record<string, unknown>[]
  return rows.map((r) => ({
    contentId: String(r.content_id ?? r.id ?? ''),
    distance: Number(r._distance ?? 0)
  }))
}

/** 删除指定 content_id 的全部向量（写锁串行；损坏时重建空表） */
export async function deleteVectors(tableName: VectorTable, contentId: string): Promise<void> {
  await withWriteLock(tableName, async () => {
    const db = await getLanceDb()
    const names = await db.tableNames()
    if (!names.includes(tableName)) return
    try {
      const table = await db.openTable(tableName)
      await table.delete(`content_id = '${contentId.replace(/'/g, "''")}'`)
    } catch (err) {
      if (!isCorruptError(err)) throw err
      console.warn(`[lancedb] ${tableName} 损坏，重建空表`)
      await db.dropTable(tableName)
    }
  })
}

/** 合并小事务/碎片文件（写锁串行，防与其他写操作并发损坏） */
export async function optimizeTable(tableName: VectorTable): Promise<void> {
  await withWriteLock(tableName, async () => {
    const db = await getLanceDb()
    const names = await db.tableNames()
    if (!names.includes(tableName)) return
    const table = await db.openTable(tableName)
    await table.optimize({ cleanupOlderThan: new Date(), deleteUnverified: true })
  })
}

export async function closeLanceDb(): Promise<void> {
  dbConn = null
}
