import { app, BrowserWindow, protocol, net } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerIpc } from './ipc'
import { closeDb } from './db'
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
      /* oasis-media://raw?p=<abs> → 任意图片路径（以图搜图预览），仅限图片后缀 */
      const p = u.searchParams.get('p') ?? ''
      if (p && IMAGE_EXT.test(p)) filePath = p
    }

    if (!filePath || !IMAGE_EXT.test(filePath)) {
      return new Response(null, { status: 403 })
    }
    return net.fetch(pathToFileURL(filePath).toString())
  })
}

function createWindow(): void {
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

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
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

  /* 补扫：模型就绪时，把历史 needs_reindex 的内容收编进嵌入队列 */
  const queued = reindexPending()
  if (queued > 0) console.log(`[embed-pipeline] 启动补扫 ${queued} 条待嵌入内容`)

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

app.on('will-quit', () => {
  void stopWatching()
  closeDb()
})
