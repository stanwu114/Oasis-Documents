import * as lancedb from '@lancedb/lancedb'
import { getVectorDbPath } from './dataLocation'

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

/** 向量检索 → { contentId, score }（score = 1 - distance，越大越相关） */
export async function searchVectors(
  tableName: VectorTable,
  queryVector: number[],
  limit = 20
): Promise<{ contentId: string; score: number }[]> {
  const db = await getLanceDb()
  const names = await db.tableNames()
  if (!names.includes(tableName)) return []

  const table = await db.openTable(tableName)
  const rows = (await table.search(queryVector).limit(limit).toArray()) as Record<string, unknown>[]
  return rows.map((r) => ({
    contentId: String(r.content_id ?? r.id ?? ''),
    score: 1 - Number(r._distance ?? 0)
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
