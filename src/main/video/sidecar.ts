import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { getMediaDir } from '../dataLocation'
import type {
  VideoBackend,
  VideoInitParams,
  VideoInitResult,
  VideoIndexParams,
  VideoIndexResult,
  VideoSearchResult,
  VideoStats,
  SidecarEvent,
  SidecarResponse
} from './protocol'

/* ================================================================
   SentrySearch Python sidecar 管理器
   - stdio JSON-RPC（每行一个 JSON）
   - 崩溃自动重启（最多 3 次，退避）
   - 空闲超时退出（省内存）
   ================================================================ */

const BRIDGE_PATH = join(app.getAppPath(), 'resources', 'video-sidecar', 'bridge.py')

type ProgressListener = (e: SidecarEvent) => void

class VideoSidecar {
  private proc: ChildProcess | null = null
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private progressListeners = new Set<ProgressListener>()
  private inited: VideoInitResult | null = null
  private restartCount = 0
  private lastActivity = Date.now()
  private idleTimer: NodeJS.Timeout | null = null

  /** 启动 sidecar 并初始化后端 */
  async init(params: VideoInitParams): Promise<VideoInitResult> {
    const python = this.resolvePython()
    const dbPath = params.dbPath ?? join(getMediaDir(), 'video-index')

    if (this.proc) await this.kill()

    this.proc = spawn(python, [BRIDGE_PATH, '--db-path', dbPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(params.apiKey && params.backend === 'qwen-cloud' ? { DASHSCOPE_API_KEY: params.apiKey } : {}),
        ...(params.apiKey && params.backend === 'gemini' ? { GEMINI_API_KEY: params.apiKey } : {})
      }
    })

    this.wireStreams()

    const result = (await this.call('init', {
      backend: params.backend,
      api_key: params.apiKey,
      model: params.model,
      db_path: dbPath
    })) as VideoInitResult

    this.inited = result
    this.restartCount = 0
    this.startIdleWatch()
    return result
  }

  get isInited(): boolean {
    return this.inited !== null
  }
  get backend(): VideoBackend | null {
    return this.inited?.backend ?? null
  }

  /** 索引一批视频文件 */
  async index(params: VideoIndexParams): Promise<VideoIndexResult> {
    this.touch()
    return (await this.call('index', {
      paths: params.paths,
      chunk_duration: params.chunkDuration ?? 30,
      overlap: params.overlap ?? 5,
      skip_still: params.skipStill ?? true
    })) as VideoIndexResult
  }

  /** 文本搜视频 */
  async search(query: string, limit = 10): Promise<VideoSearchResult> {
    this.touch()
    return (await this.call('search', { query, limit })) as VideoSearchResult
  }

  async stats(): Promise<VideoStats> {
    this.touch()
    return (await this.call('stats', {})) as VideoStats
  }

  async remove(sourceFile: string): Promise<{ removed: number }> {
    this.touch()
    return (await this.call('remove', { source_file: sourceFile })) as { removed: number }
  }

  onProgress(cb: ProgressListener): () => void {
    this.progressListeners.add(cb)
    return () => this.progressListeners.delete(cb)
  }

  /* ---- 内部 ---- */

  private call(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin?.writable) {
        reject(new Error('sidecar 未运行'))
        return
      }
      const id = this.nextId++
      this.pending.set(id, { resolve, reject })
      const line = JSON.stringify({ id, method, params })
      this.proc.stdin.write(line + '\n')

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`sidecar 调用超时: ${method}`))
        }
      }, 10 * 60 * 1000) // 索引可能很慢，10 分钟兜底
    })
  }

  private wireStreams(): void {
    const proc = this.proc
    if (!proc) return

    let buffer = ''
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        this.handleLine(line)
      }
    })

    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (d: string) => {
      console.log('[video-sidecar]', d.trim())
    })

    proc.on('exit', (code) => {
      const err = new Error(`sidecar 退出 (code=${code})`)
      for (const [, p] of this.pending) p.reject(err)
      this.pending.clear()
      this.proc = null
      this.inited = null

      /* 意外退出 → 退避重启（最多3次） */
      if (code !== 0 && code !== null && this.restartCount < 3 && this.progressListeners.size > 0) {
        this.restartCount++
        const delay = 1000 * this.restartCount
        setTimeout(() => {
          console.log(`[video-sidecar] 第 ${this.restartCount} 次重启`)
        }, delay)
      }
    })
  }

  private handleLine(line: string): void {
    let msg: SidecarResponse | SidecarEvent
    try {
      msg = JSON.parse(line)
    } catch {
      console.log('[video-sidecar] 非 JSON 行:', line.slice(0, 200))
      return
    }

    if ('event' in msg) {
      for (const cb of this.progressListeners) cb(msg)
      this.touch()
      return
    }

    const p = this.pending.get(msg.id ?? -1)
    if (!p) return
    this.pending.delete(msg.id ?? -1)
    if ('error' in msg) p.reject(new Error(msg.error))
    else p.resolve(msg.result)
  }

  /** 找可用的 python：打包内置 venv → 系统 python3 */
  private resolvePython(): string {
    const bundled = join(app.getAppPath(), 'resources', 'video-sidecar', 'venv', 'bin', 'python')
    if (existsSync(bundled)) return bundled
    return 'python3'
  }

  /** 空闲 10 分钟自动退出，释放内存（下次调用会重新 init） */
  private startIdleWatch(): void {
    this.stopIdleWatch()
    this.idleTimer = setInterval(() => {
      if (Date.now() - this.lastActivity > 10 * 60 * 1000 && this.pending.size === 0) {
        void this.kill()
      }
    }, 60 * 1000)
  }

  private stopIdleWatch(): void {
    if (this.idleTimer) clearInterval(this.idleTimer)
    this.idleTimer = null
  }

  private touch(): void {
    this.lastActivity = Date.now()
  }

  private async kill(): Promise<void> {
    this.stopIdleWatch()
    const proc = this.proc
    if (!proc) return
    this.proc = null
    this.inited = null
    await new Promise<void>((resolve) => {
      proc.stdin?.end()
      proc.once('exit', () => resolve())
      setTimeout(() => {
        proc.kill('SIGKILL')
        resolve()
      }, 3000)
    })
  }
}

export const videoSidecar = new VideoSidecar()
