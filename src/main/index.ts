import { app, BrowserWindow, protocol, net } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerIpc } from './ipc'
import { closeDb, getDb } from './db'
import { startWatching, stopWatching, onIndexProgress } from './indexer/watcher'
import { reindexPending } from './indexer/embedding-pipeline'
import { startRssScheduler } from './subscriptions/rss'
import { startNewsletterScheduler } from './newsletter'
import { getMediaDir, getThumbnailsDir } from './dataLocation'

/* 媒体协议：渲染进程（http/dev 或 file/prod）统一经此加载本地图片，
   避免 Chromium 禁止 http 页面直接访问 file:// 的限制，且可做目录白名单 */
protocol.registerSchemesAsPrivileged([
  { scheme: 'oasis-media', privileges: { standard: true, secure: true, stream: true } }
])

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif|tiff?|heic)$/i

/* N09：raw 协议白名单——已入库路径（30 秒缓存）或应用媒体目录 */
let rawPathsCache = new Set<string>()
let rawPathsAt = 0
function isRawPathAllowed(p: string): boolean {
  if (p.startsWith(getMediaDir())) return true
  if (Date.now() - rawPathsAt > 30_000) {
    rawPathsAt = Date.now()
    try {
      const db = getDb()
      const rows = db.prepare(`SELECT source_path FROM contents WHERE source_path IS NOT NULL`).all() as { source_path: string }[]
      rawPathsCache = new Set(rows.map((r) => r.source_path))
    } catch {
      rawPathsCache = new Set()
    }
  }
  return rawPathsCache.has(p)
}

function registerMediaProtocol(): void {
  protocol.handle('oasis-media', (request) => {
    const u = new URL(request.url)
    let filePath: string | null = null

    if (u.hostname === 'thumb') {
      /* oasis-media://thumb/<name> → 缩略图目录 */
      const name = decodeURIComponent(u.pathname.replace(/^\/+/, ''))
      if (name && !name.includes('..')) filePath = join(getThumbnailsDir(), name)
    } else if (u.hostname === 'media') {
      /* oasis-media://media/<sub…> → 媒体目录（平台图、feed 图标等） */
      const rel = u.pathname.replace(/^\/+/, '').split('/').map(decodeURIComponent)
      if (rel.length > 0 && !rel.some((r) => !r || r === '..')) filePath = join(getMediaDir(), ...rel)
    } else if (u.hostname === 'raw') {
      /* oasis-media://raw?p=<abs> → N09 收口：仅允许已入库路径或应用媒体目录 */
      const p = u.searchParams.get('p') ?? ''
      if (p && IMAGE_EXT.test(p) && isRawPathAllowed(p)) filePath = p
    }

    if (!filePath || !IMAGE_EXT.test(filePath)) {
      return new Response(null, { status: 403 })
    }
    return net.fetch(pathToFileURL(filePath).toString())
  })
}

function createWindow(): BrowserWindow {
  /* N19：外链一律走系统浏览器，禁止远程页面在应用窗口内打开 */
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    trafficLightPosition: { x: 14, y: 26 },
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void import('electron').then(({ shell }) => shell.openExternal(url))
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

/* N08：单实例锁——两个主进程并发写 LanceDB 会清单失配损坏 */
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
}

app.whenReady().then(() => {
  registerMediaProtocol()
  registerIpc()

  /* 索引进度 → 渲染进程 */
  onIndexProgress((p) => {
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('index:progress', p))
  })

  /* 启动目录监控（watch_paths 表中启用的目录） */
  void startWatching().catch((e) => console.error('[watcher] 启动失败:', e))

  /* N07：补扫延迟到窗口就绪后的空闲时段——首屏渲染与首次搜索不再与
     批量推理抢资源（启动即三线并发是首分钟卡顿的来源） */
  const win = createWindow()
  win.once('ready-to-show', () => {
    setImmediate(() => setImmediate(() => {
      const queued = reindexPending()
      if (queued > 0) console.log(`[embed-pipeline] 空闲补扫 ${queued} 条待嵌入内容`)
    }))
  })

  /* F05：RSS 持久调度（每 30 分钟检查，单源最小间隔 1 小时，连续失败自动禁用） */
  startRssScheduler()

  /* Newsletter/IMAP：启用时定时拉取（每 30 分钟） */
  startNewsletterScheduler()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/* N04+N15：退出前异步收尾——先 flush 嵌入缓冲（防丢向量），再停 watcher，最后关库 */
app.on('will-quit', (event) => {
  if ((app as unknown as { __drained?: boolean }).__drained) return
  event.preventDefault() /* 拦截首次退出，收尾完成后真正退出 */
  ;(app as unknown as { __drained?: boolean }).__drained = true
  void (async () => {
    try {
      const { flushAll } = await import('./indexer/embedding-pipeline')
      await flushAll() /* 缓冲向量落盘（≤几十条，毫秒级） */
    } catch (e) {
      console.warn('[quit] 嵌入缓冲 flush 失败（下次启动补扫自愈）:', e instanceof Error ? e.message : e)
    }
    try {
      await stopWatching()
    } catch {
      /* watcher 关闭失败不阻塞退出 */
    }
    closeDb()
    app.quit()
  })()
})
