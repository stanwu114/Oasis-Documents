import chokidar, { type FSWatcher } from 'chokidar'
import { getDb } from '../db'
import { isSupportedFile, indexFiles, removeByPath } from './pipeline'
import type { IndexProgress } from './pipeline'

/* ================================================================
   目录监控：watch_paths 表里的目录 → chokidar 监听
   新增/变更 → 索引管线；删除 → 移除记录
   ================================================================ */

const watchers = new Map<string, FSWatcher>()
/* R06：每个监控根的防抖定时器登记——移除时必须清理，
   否则关闭 watcher 后 3 秒内的 pending 定时器仍会把已删目录的文件重新入库 */
const pendingTimers = new Map<string, NodeJS.Timeout[]>()
let progressCb: ((p: IndexProgress) => void) | null = null

/** 应用启动时调用：监听 watch_paths 表里的所有目录 */
export async function startWatching(): Promise<void> {
  const db = getDb()
  const roots = (db.prepare(`SELECT path FROM watch_paths WHERE enabled = 1`).all() as { path: string }[]).map(
    (r) => r.path
  )
  for (const root of roots) await addWatch(root)
}

export async function stopWatching(): Promise<void> {
  for (const [, w] of watchers) await w.close()
  watchers.clear()
}

export async function addWatch(root: string): Promise<void> {
  if (watchers.has(root)) return

  const w = chokidar.watch(root, {
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 500 },
    ignored: (path: string) => isIgnored(path)
  })

  /* 防抖队列：短时间大量事件合并成一次批量索引 */
  let queue: string[] = []
  let timer: NodeJS.Timeout | null = null
  let removeQueue: string[] = []
  let removeTimer: NodeJS.Timeout | null = null
  let closed = false

  const armTimer = (fn: () => void, ms: number): NodeJS.Timeout => {
    const t = setTimeout(() => {
      /* 从登记中移除自己 */
      const list = pendingTimers.get(root) ?? []
      const idx = list.indexOf(t)
      if (idx >= 0) list.splice(idx, 1)
      fn()
    }, ms)
    ;(pendingTimers.get(root) ?? pendingTimers.set(root, []).get(root)!).push(t)
    return t
  }

  const flushAdds = (): void => {
    const batch = [...new Set(queue)]
    queue = []
    timer = null
    if (batch.length === 0 || closed) return
    void indexFiles(batch, (p) => progressCb?.(p)).catch((e) => console.error('[indexer]', e))
  }
  const flushRemoves = (): void => {
    const batch = [...removeQueue]
    removeQueue = []
    removeTimer = null
    if (closed) return
    for (const p of batch) removeByPath(p)
  }

  /* 初始扫描与后续新增统一走 add 事件（ignoreInitial: false） */
  w.on('add', (path) => {
    if (closed || !isSupportedFile(path)) return
    queue.push(path)
    if (!timer) timer = armTimer(flushAdds, 3000)
  })
  w.on('change', (path) => {
    /* R05：内容变化直接入队——pipeline 按路径检测哈希差异后
       保留资产 ID 更新版本，不再删旧记录重建（标签不再丢失） */
    if (closed || !isSupportedFile(path)) return
    queue.push(path)
    if (!timer) timer = armTimer(flushAdds, 3000)
  })
  w.on('unlink', (path) => {
    if (closed) return
    removeQueue.push(path)
    if (!removeTimer) removeTimer = armTimer(flushRemoves, 3000)
  })
  w.on('error', (err) => console.error('[watcher]', root, err))

  watchers.set(root, w)
}

export async function removeWatch(root: string): Promise<void> {
  /* R06：先清 pending 定时器并置关闭标志，再关 watcher */
  for (const t of pendingTimers.get(root) ?? []) clearTimeout(t)
  pendingTimers.delete(root)
  const w = watchers.get(root)
  if (w) {
    await w.close()
    watchers.delete(root)
  }
}

export function onIndexProgress(cb: (p: IndexProgress) => void): void {
  progressCb = cb
}

/* 忽略噪音目录（任意层级命中即忽略） */
const IGNORE_NAMES = new Set([
  'node_modules', '.git', '.Trash', 'Library', 'Caches', 'Cache', '.cache',
  '.venv', 'venv', '__pycache__', '.DS_Store', 'dist', 'build', '.next', 'target'
])

function isIgnored(path: string): boolean {
  const parts = path.split('/')
  for (const p of parts) {
    if (IGNORE_NAMES.has(p)) return true
  }
  return false
}
