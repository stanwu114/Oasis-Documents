import { BrowserWindow } from 'electron'

/* ================================================================
   导入会话进度 + 完成报告统计
   - indexing 0–50%，embedding 50–100%
   - 全程统计：导入（新增/跳过/失败）与向量化（成功/失败）及原因聚合
   - 心跳收敛：30 秒无活动强制完成，进度绝不永久卡住
   ================================================================ */

export interface FailReason {
  reason: string
  count: number
}

export interface ImportProgressState {
  phase: 'idle' | 'indexing' | 'embedding' | 'done'
  total: number
  done: number
  embedTotal: number
  embedDone: number
  percent: number
  sessionId: number
  /* 完成报告统计 */
  indexed: number
  skipped: number
  indexFailed: number
  indexFailReasons: FailReason[]
  embedded: number
  embedFailed: number
  embedFailReasons: FailReason[]
}

const freshStats = (): Pick<
  ImportProgressState,
  'indexed' | 'skipped' | 'indexFailed' | 'indexFailReasons' | 'embedded' | 'embedFailed' | 'embedFailReasons'
> => ({
  indexed: 0,
  skipped: 0,
  indexFailed: 0,
  indexFailReasons: [],
  embedded: 0,
  embedFailed: 0,
  embedFailReasons: []
})

let state: ImportProgressState = { phase: 'idle', total: 0, done: 0, embedTotal: 0, embedDone: 0, percent: 0, sessionId: 0, ...freshStats() }
let activeBatches = 0
let lastBroadcast = 0
let heartbeat: NodeJS.Timeout | null = null
let lastEmbedDone = -1
let lastProgressAt = Date.now()

function touch(): void {
  lastProgressAt = Date.now()
}

/** 心跳收敛：两重兜底——
    1) embedding 阶段完成计数 60 秒零增长 → 强制 done
    2) 会话总时长超 10 分钟（批次计数失配悬挂等）→ 强制复位收敛 */
function ensureHeartbeat(): void {
  if (heartbeat) return
  const startedAt = Date.now()
  heartbeat = setInterval(() => {
    if (state.phase === 'indexing' || state.phase === 'embedding') {
      const stalledTooLong = Date.now() - startedAt > 10 * 60_000
      if (stalledTooLong) {
        console.warn('[import-progress] 会话超时，强制复位收敛')
        activeBatches = 0
        forceSettle('会话超时收敛')
      } else if (state.phase === 'embedding' && activeBatches === 0) {
        if (state.embedDone !== lastEmbedDone) {
          lastEmbedDone = state.embedDone
          lastProgressAt = Date.now()
        } else if (Date.now() - lastProgressAt > 60_000) {
          console.warn('[import-progress] 进度停滞，强制收敛进度会话')
          forceSettle('进度停滞收敛')
        }
      }
    }
    if (state.phase === 'done' || state.phase === 'idle') {
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = null
    }
  }, 5000)
}

/** R17：强制收敛不再冒充全部成功——未完成的差额计入失败并注明原因 */
function forceSettle(reason: string): void {
  const unfinished = Math.max(0, state.embedTotal - state.embedDone)
  if (unfinished > 0) {
    state.embedFailed += unfinished
    addReason(state.embedFailReasons, `${reason}（未确认完成）`)
  }
  state.embedDone = Math.max(state.embedDone, state.embedTotal)
  state.done = Math.max(state.done, state.total)
  state.phase = 'done'
  touch()
  broadcast(true)
}

function broadcast(force = false): void {
  const now = Date.now()
  if (!force && now - lastBroadcast < 90) return
  lastBroadcast = now
  const wins = BrowserWindow.getAllWindows()
  if (wins.length === 0) return
  const payload = { ...state, percent: calcPercent() }
  for (const w of wins) {
    if (!w.isDestroyed()) w.webContents.send('import:progress', payload)
  }
}

function calcPercent(): number {
  if (state.phase === 'done') return 100
  /* 索引阶段严格按 done/total 走 0–50%，不预支嵌入进度；
     嵌入完成情况等批次切换后自然体现在 50–100% 段 */
  if (state.phase === 'indexing' || activeBatches > 0) {
    if (state.total <= 0) return 0
    return Math.min(49, Math.floor((Math.max(0, Math.min(1, state.done / state.total))) * 50))
  }
  if (state.phase === 'embedding') {
    if (state.embedTotal <= 0) return 50
    const ratio = Math.max(0, Math.min(1, state.embedDone / state.embedTotal)) /* 钳制防计数错位冲高 */
    return Math.min(99, 50 + Math.floor(ratio * 50))
  }
  return 0
}

function addReason(list: FailReason[], label: string): void {
  const hit = list.find((r) => r.reason === label)
  if (hit) hit.count++
  else list.push({ reason: label, count: 1 })
}

/** 错误信息 → 短标签（完成报告里展示） */
export function classifyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/heif|heic/i.test(msg)) return 'HEIC 图片暂不支持'
  if (/decode|unsupported|premature|bad seek|corrupt|Vips/i.test(msg)) return '格式不支持'
  if (/超时|timeout|ETIMEDOUT/i.test(msg)) return '处理超时'
  if (/EACCES|permission/i.test(msg)) return '无访问权限'
  if (/ENOENT|no such file/i.test(msg)) return '文件不存在'
  if (/\b4\d\d\b/.test(msg)) return 'API 请求被拒'
  if (/\b5\d\d\b|network|fetch failed/i.test(msg)) return '网络/服务错误'
  return msg.length > 40 ? `${msg.slice(0, 40)}…` : msg
}

/** 一批文件开始索引；空闲→忙碌时开启新会话（清零统计） */
export function beginIndexSession(total: number): void {
  const wasIdle = state.phase === 'idle' || state.phase === 'done'
  activeBatches++
  state = {
    ...state,
    ... (wasIdle ? freshStats() : {}),
    phase: 'indexing',
    total: wasIdle ? total : state.total + total,
    done: wasIdle ? 0 : state.done,
    percent: 0,
    sessionId: wasIdle ? state.sessionId + 1 : state.sessionId
  }
  touch()
  ensureHeartbeat()
  lastEmbedDone = -1
  lastProgressAt = Date.now()
  broadcast(true)
}

/** 补扫向量化会话：直接从嵌入阶段开始 */
export function beginEmbeddingSession(total: number): void {
  state = { phase: 'embedding', total: 0, done: 0, embedTotal: total, embedDone: 0, percent: 50, sessionId: state.sessionId + 1, ...freshStats() }
  touch()
  ensureHeartbeat()
  lastEmbedDone = -1
  lastProgressAt = Date.now()
  broadcast(true)
}

/** 单个文件完成索引 */
export function tickIndexSession(): void {
  state.done++
  broadcast()
}

/** 索引结果上报：新增 / 跳过(重复) / 失败 */
export function reportIndexResult(kind: 'ok' | 'skip' | 'fail', err?: unknown): void {
  if (kind === 'ok') state.indexed++
  else if (kind === 'skip') state.skipped++
  else {
    state.indexFailed++
    addReason(state.indexFailReasons, classifyError(err))
  }
  touch()
  broadcast()
}

/** 向量化结果上报 */
export function reportEmbedResult(kind: 'ok' | 'fail', err?: unknown): void {
  if (kind === 'ok') state.embedded++
  else {
    state.embedFailed++
    addReason(state.embedFailReasons, classifyError(err))
  }
  touch()
  broadcast()
}

/** 索引批次结束；enqueued = 该批进入嵌入队列的任务数（累计并入） */
export function endIndexSession(enqueued: number): void {
  activeBatches = Math.max(0, activeBatches - 1)
  state.embedTotal += enqueued
  if (activeBatches === 0) {
    state.done = state.total
    state.phase = state.embedTotal > 0 ? 'embedding' : 'done'
  }
  touch()
  broadcast(true)
}

/** 单个嵌入任务完成（成功或失败都计数） */
export function tickEmbedSession(): void {
  state.embedDone++
  if (state.phase === 'embedding' && activeBatches === 0 && state.embedDone >= state.embedTotal) {
    state.phase = 'done'
  }
  broadcast()
}

/** 队列排空兜底：计数错位时强制收敛 */
export function settleEmbeddingSession(): void {
  if (state.phase === 'embedding' && activeBatches === 0) {
    state.embedDone = Math.max(state.embedDone, state.embedTotal)
    state.phase = 'done'
    touch()
    broadcast(true)
  }
}

export function getImportProgress(): ImportProgressState {
  return { ...state, percent: calcPercent() }
}
