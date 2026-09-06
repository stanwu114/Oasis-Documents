import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { mkdirSync, chmodSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { getMediaParserConf, saveMediaParserConf } from './external'

/* ================================================================
   小红书内置解析引擎(应用托管 XHS-Downloader)
   - 按需下载官方 macOS 可执行包(GitHub Releases,约 40MB)解压到
     userData/sidecars/xhs,作为子进程运行其 API 模式(127.0.0.1:5556)
   - 应用退出时终止;解析时惰性拉起
   - 许可注意:XHS-Downloader 为 GPL-3.0,本项目仅下载并作为独立
     进程调用其公开 HTTP API,不修改/不捆绑其源码
   ================================================================ */

const RELEASE_URL = 'https://github.com/JoeanAmier/XHS-Downloader/releases/download/2.7/XHS-Downloader_V2.7_macOS_ARM64.zip'
/* 国内加速镜像优先(用户网络环境),GitHub 直连兜底;镜像失效可在此增删 */
const DOWNLOAD_SOURCES = [
  `https://ghfast.top/${RELEASE_URL}`,
  `https://ghproxy.net/${RELEASE_URL}`,
  `https://mirror.ghproxy.com/${RELEASE_URL}`,
  `https://gh-proxy.com/${RELEASE_URL}`,
  RELEASE_URL
]
export const XHS_API_BASE = 'http://127.0.0.1:5556'

function sidecarRoot(): string {
  return join(app.getPath('userData'), 'sidecars', 'xhs')
}

/** 在解压目录中定位可执行文件 main(cx_Freeze 包结构为 文件夹/main) */
export function xhsBinaryPath(): string | null {
  const root = sidecarRoot()
  const find = (dir: string, depth: number): string | null => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return null
    }
    for (const e of entries) {
      const p = join(dir, e)
      if (e === 'main' && statSync(p).isFile()) return p
      if (depth > 0 && statSync(p).isDirectory() && !e.startsWith('.')) {
        const hit = find(p, depth - 1)
        if (hit) return hit
      }
    }
    return null
  }
  return find(root, 2)
}

export function isXhsInstalled(): boolean {
  return xhsBinaryPath() !== null
}

/* ---- 进程生命周期 ---- */
let proc: ChildProcess | null = null
let starting: Promise<boolean> | null = null

export function isXhsRunning(): boolean {
  return proc !== null && proc.exitCode === null
}

async function waitHealthy(timeoutMs = 25_000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${XHS_API_BASE}/docs`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) return true
    } catch {
      /* 尚未就绪 */
    }
    await new Promise((r) => setTimeout(r, 600))
  }
  return false
}

/** 拉起内置引擎(API 模式);已在运行直接返回 true */
export async function startXhsSidecar(): Promise<boolean> {
  if (isXhsRunning()) return true
  if (starting) return starting
  const bin = xhsBinaryPath()
  if (!bin) return false

  starting = (async () => {
    proc = spawn(bin, ['api'], {
      cwd: join(bin, '..'), /* Volume 目录随可执行文件创建 */
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TERM: 'dumb' }
    })
    proc.stdout?.on('data', (d: Buffer) => console.log('[xhs-sidecar]', d.toString().trim().slice(0, 300)))
    proc.stderr?.on('data', (d: Buffer) => console.warn('[xhs-sidecar]', d.toString().trim().slice(0, 300)))
    proc.on('exit', (code) => {
      console.log(`[xhs-sidecar] 退出 code=${code}`)
      proc = null
    })

    const ok = await waitHealthy()
    if (ok) {
      /* 引擎在线:接管解析配置(用户自填了其他地址则不动) */
      const conf = getMediaParserConf()
      if (!conf.xhs || conf.xhs.startsWith('http://127.0.0.1:555')) {
        saveMediaParserConf({ ...conf, xhs: XHS_API_BASE })
      }
    }
    return ok
  })()

  try {
    return await starting
  } finally {
    starting = null
  }
}

export function stopXhsSidecar(): void {
  if (proc) {
    proc.kill('SIGTERM')
    setTimeout(() => proc?.kill('SIGKILL'), 2000)
    proc = null
  }
}

/** 解析前置:内置模式开启时确保引擎在跑 */
export async function ensureXhsRunning(): Promise<void> {
  const conf = getMediaParserConf()
  if (conf.builtinXhs && isXhsInstalled() && !isXhsRunning()) {
    await startXhsSidecar().catch(() => false)
  }
}

/* ---- 安装(下载 + 解压 + 权限) ---- */

export async function installXhsSidecar(onProgress?: (pct: number) => void): Promise<void> {
  if (isXhsInstalled()) return
  const root = sidecarRoot()
  mkdirSync(root, { recursive: true })
  const zipPath = join(root, 'xhs.zip')

  /* 依次尝试下载源,流式落盘 */
  let lastErr: unknown = null
  let downloaded = false
  for (const url of DOWNLOAD_SOURCES) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const total = parseInt(res.headers.get('content-length') ?? '0', 10)
      const { createWriteStream } = await import('node:fs')
      const { Readable } = await import('node:stream')
      const { pipeline } = await import('node:stream/promises')
      let got = 0
      const source = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
      source.on('data', (c: Buffer) => {
        got += c.length
        if (total) onProgress?.(Math.min(0.95, got / total))
      })
      await pipeline(source, createWriteStream(zipPath))
      if (statSync(zipPath).size < 10 * 1024 * 1024) throw new Error('包体积异常(疑似镜像返回错误页)')
      downloaded = true
      break
    } catch (e) {
      lastErr = e
      console.warn('[xhs-sidecar] 下载源失败:', url, e instanceof Error ? e.message : e)
    }
  }
  if (!downloaded) throw new Error(`全部下载源失败(已尝试 ${DOWNLOAD_SOURCES.length} 个镜像): ${lastErr instanceof Error ? lastErr.message : lastErr}`)

  /* 解压(macOS 自带 unzip) */
  onProgress?.(0.96)
  await new Promise<void>((resolve, reject) => {
    execFile('unzip', ['-o', '-q', zipPath, '-d', root], { timeout: 120_000 }, (err) =>
      err ? reject(new Error(`解压失败: ${err.message}`)) : resolve()
    )
  })

  const bin = xhsBinaryPath()
  if (!bin) throw new Error('解压后未找到可执行文件 main')
  chmodSync(bin, 0o755)
  /* 清除 macOS 隔离标记(未签名二进制;应用内下载一般不带,兜底执行) */
  await new Promise<void>((resolve) => {
    execFile('xattr', ['-cr', join(bin, '..')], { timeout: 30_000 }, () => resolve())
  })
  /* 安装完成标记 */
  writeFileSync(join(root, 'installed.json'), JSON.stringify({ url: RELEASE_URL, at: Date.now() }))
  onProgress?.(1)
}

/* 内置模式开关持久化(挂在 media_parser 配置上) */
export function setBuiltinXhs(enabled: boolean): void {
  const conf = getMediaParserConf()
  saveMediaParserConf({ ...conf, builtinXhs: enabled })
}

export function builtinXhsEnabled(): boolean {
  return getMediaParserConf().builtinXhs === true && isXhsInstalled()
}

/** 首次启用:安装 + 拉起 + 写配置 */
export async function enableBuiltinXhs(onProgress?: (pct: number) => void): Promise<boolean> {
  if (!isXhsInstalled()) await installXhsSidecar(onProgress)
  setBuiltinXhs(true)
  return startXhsSidecar()
}

export function xhsSidecarStatus(): { installed: boolean; running: boolean; enabled: boolean } {
  return {
    installed: isXhsInstalled(),
    running: isXhsRunning(),
    enabled: getMediaParserConf().builtinXhs === true
  }
}
