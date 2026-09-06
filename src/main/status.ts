import { getDb } from './db'
import { getEmbedders, embedderReadiness, loadEmbeddingSettings } from './embedder'
import { getImportProgress } from './import-progress'
import type { SystemStatus } from '../shared/ipc'

/* ================================================================
   系统状态总览(状态页数据源,替代原设置页内的索引诊断模块)
   ================================================================ */

export function buildSystemStatus(): SystemStatus {
  const db = getDb()
  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n

  /* 导入侧:已入库的本地文件;进行中会话的剩余量即"待导入" */
  const importedFiles = count(`SELECT COUNT(*) AS n FROM contents WHERE source_path IS NOT NULL`)
  const prog = getImportProgress()
  const pendingImport =
    prog.phase === 'indexing' ? Math.max(0, prog.total - prog.done) : 0

  /* 向量化侧:needs_reindex=1 即待处理;已处理 = 有 indexed_at 且不需重嵌 */
  const pendingEmbed = count(`SELECT COUNT(*) AS n FROM contents WHERE needs_reindex = 1`)
  const embedded = count(
    `SELECT COUNT(*) AS n FROM contents WHERE indexed_at IS NOT NULL AND needs_reindex = 0
       AND ((type = 'image') OR (type != 'image' AND COALESCE(content,'') != ''))`
  )

  /* 失败明细:提取失败(extractError)与嵌入失败(embedError)持久化在 meta */
  const importFails = (
    db
      .prepare(
        `SELECT title, source_path, json_extract(meta, '$.extractError') AS err
         FROM contents WHERE json_extract(meta, '$.extractError') IS NOT NULL
         ORDER BY updated_at DESC LIMIT 50`
      )
      .all() as { title: string; source_path: string | null; err: string }[]
  ).map((r) => ({ name: r.source_path ?? r.title, reason: String(r.err).slice(0, 120) }))

  const embedFails = (
    db
      .prepare(
        `SELECT title, source_path, json_extract(meta, '$.embedError') AS err
         FROM contents WHERE json_extract(meta, '$.embedError') IS NOT NULL
         ORDER BY updated_at DESC LIMIT 50`
      )
      .all() as { title: string; source_path: string | null; err: string }[]
  ).map((r) => ({ name: r.source_path ?? r.title, reason: String(r.err).slice(0, 120) }))

  /* 当前会话的失败原因聚合(内存态,补充持久化明细) */
  if (prog.indexFailReasons.length > 0 && importFails.length === 0) {
    for (const r of prog.indexFailReasons.slice(0, 10)) {
      importFails.push({ name: `（本会话）${r.reason}`, reason: `×${r.count}` })
    }
  }
  if (prog.embedFailReasons.length > 0 && embedFails.length === 0) {
    for (const r of prog.embedFailReasons.slice(0, 10)) {
      embedFails.push({ name: `（本会话）${r.reason}`, reason: `×${r.count}` })
    }
  }

  /* 模型使用状态 */
  const { text, image } = getEmbedders()
  const ready = embedderReadiness()
  const settings = loadEmbeddingSettings()
  const providerLabel =
    settings.onlineProvider?.provider === 'bailian'
      ? '百炼'
      : settings.onlineProvider?.provider === 'zhipu'
        ? '智谱'
        : settings.onlineProvider?.provider === 'custom'
          ? '自定义'
          : null
  const onlineActive = providerLabel !== null && settings.defaultProvider !== 'local'

  const textEmbedding = !ready.textReady
    ? '未就绪（检索回退关键词）'
    : onlineActive
      ? `${text.info.name}（在线 · ${providerLabel}）`
      : `${text.info.name}（本地）`
  const imageEmbedding = ready.imageReady ? `${image.info.name}（本地）` : '未就绪（图片语义检索不可用）'
  const textLlm = settings.onlineLlm?.enabled && settings.onlineLlm?.model
    ? `${settings.onlineLlm.model}（在线 · ${settings.onlineLlm.provider}）`
    : '未配置（AI 打标回退本地抽取）'
  const multimodal = settings.onlineMultimodal?.enabled && settings.onlineMultimodal?.model
    ? `${settings.onlineMultimodal.model}（在线 · ${settings.onlineMultimodal.provider}）`
    : settings.modelAssignments?.multimodal
      ? `${settings.modelAssignments.multimodal}（在线 · 已指派）`
      : '未配置'
  const audio = settings.modelAssignments?.audio ? `${settings.modelAssignments.audio}（在线 · 已指派）` : '未配置（预留）'

  return {
    importedFiles,
    pendingImport,
    embedded,
    pendingEmbed,
    importFails,
    embedFails,
    models: { textEmbedding, imageEmbedding, textLlm, multimodal, audio }
  }
}
