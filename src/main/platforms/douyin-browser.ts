import { extractRenderedAlbum, inspectDouyinDocument } from './douyin-dom'
import { useNodeTransport } from './browser-transport'
import { matchesShareDescription } from './share-text'
import { BrowserWindow, session } from 'electron'
import { extractDouyinData, extractRouterData, type DyParsed } from './douyin-data'
import { douyinPostId, isDouyinUrl } from './douyin-link'
import { httpUrl } from './page-data'

// 同一应用会话复用抖音验证状态，串行使用网络处理器，避免每条收藏都建立新身份。
let browserJob: Promise<unknown> | undefined
export async function readRenderedDouyin(id: string, signal?: AbortSignal, shareUrl?: string, description?: string, onVerification?: () => void): Promise<DyParsed> {
  const previous = browserJob
  const task = (async () => {
    await previous?.catch(() => undefined)
    signal?.throwIfAborted()
    return readInBrowser(id, signal, shareUrl, description, onVerification)
  })()
  browserJob = task
  try { return await task } finally { if (browserJob === task) browserJob = undefined }
}

/** 独立的内存会话，不共享用户浏览器凭据，退出应用后不保留登录数据。 */
async function readInBrowser(id: string, signal?: AbortSignal, shareUrl?: string, description?: string, onVerification?: () => void): Promise<DyParsed> {
  if (!/^\d{10,25}$/.test(id)) throw new Error('无效的抖音作品编号')
  signal?.throwIfAborted()
  const isolated = session.fromPartition('douyin-collection')
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  isolated.setPermissionCheckHandler(() => false)
  const win = new BrowserWindow({show: false, width: 1280, height: 900, webPreferences: {
    session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false,
    webSecurity: true, backgroundThrottling: false
  }})
  const wc = win.webContents
  wc.setAudioMuted(true)
  wc.setUserAgent(wc.getUserAgent().replace(/\sElectron\/\S+/g, '').replace(/\sOasis[- ]Documents\/\S+/g, ''))
  wc.setWindowOpenHandler(() => ({action: 'deny'}))
  const localDeadline = new AbortController()
  const deadline = AbortSignal.any([localDeadline.signal, ...(signal ? [signal] : [])])
  return new Promise<DyParsed>((resolve, reject) => {
    let done = false
    let polling = false
    let verificationOpen = false
    let timeout = setTimeout(() => localDeadline.abort(), 55_000)
    let timer: ReturnType<typeof setInterval> | undefined
    let removeTransport: (() => void) | undefined
    const transportController = new AbortController()
    const media = new Set<string>()
    const finish = (post?: DyParsed, error?: Error): void => {
      if (done) return
      done = true
      clearInterval(timer)
      clearTimeout(timeout)
      deadline.removeEventListener('abort', abort)
      isolated.webRequest.onBeforeRequest(null)
      removeTransport?.()
      transportController.abort()
      try { if (wc.debugger.isAttached()) wc.debugger.detach() } catch { /* 页面已关闭 */ }
      if (!win.isDestroyed()) win.destroy()
      if (post && post.id !== id && description && !matchesShareDescription(description, post.desc ?? '')) reject(new Error('解析作品与分享文案不一致，已停止下载'))
      else if (post) resolve(post)
      else reject(error ?? new Error('抖音页面没有返回可下载的作品'))
    }
    const abort = (): void => finish(undefined, new Error(verificationOpen ? '抖音安全验证尚未完成，导入已停止。请重新导入并在弹出的抖音窗口完成验证' : signal?.aborted ? '抖音解析已取消或超过任务时限' : '抖音页面加载超时，可能是网络连接失败或平台未返回作品详情'))
    deadline.addEventListener('abort', abort, {once: true})
    wc.on('will-navigate', (event, url) => {
      if (!isDouyinUrl(url) || (douyinPostId(url) && douyinPostId(url) !== id)) event.preventDefault()
    })
    wc.on('render-process-gone', () => finish(undefined, new Error('抖音页面加载进程退出，请重试')))
    win.on('closed', () => { if (!done) finish(undefined, new Error('导入已取消：抖音窗口在解析完成前被关闭。请重新粘贴分享文案，验证完成后窗口会自动关闭')) })
    const showVerification = (): void => {
      if (done || verificationOpen || win.isDestroyed()) return
      verificationOpen = true
      clearTimeout(timeout)
      timeout = setTimeout(() => localDeadline.abort(), 120_000)
      win.setTitle('抖音安全验证 · 完成后自动继续导入')
      win.show()
      onVerification?.()
    }
    wc.on('page-title-updated', event => { if (verificationOpen) event.preventDefault() })
    isolated.webRequest.onBeforeRequest((details, callback) => {
      // 浏览器正常发出的媒体请求可用作 blob 播放器的直链补充。
      // 验证资源可能被预加载，仅在检查到可见验证提示时显示窗口。
      if (details.resourceType === 'media' && httpUrl(details.url)) media.add(details.url)
      callback({cancel: false})
    })
    removeTransport = useNodeTransport(isolated, AbortSignal.any([deadline, transportController.signal]), (url, body) => {
      if (done || !isDouyinUrl(url)) return
      const post = extractDouyinData(body, id)
      if (post?.id === id) finish(post)
    })
    const inspect = async (): Promise<void> => {
      if (done || polling || wc.isDestroyed()) return
      polling = true
      try {
        const view = await wc.executeJavaScript(`(${inspectDouyinDocument.toString()})()` )
        if (done) return
        if (view.verification) showVerification()
        if (douyinPostId(view.url) !== id) return
        const embedded = extractRouterData(view.html, id)
        if (embedded) { finish(embedded); return }
        const album = extractRenderedAlbum(view, id, description)
        if (album) { finish(album); return }
        const direct = httpUrl(view.src)
        const sources = (view.sources as string[]).map(httpUrl).filter((u): u is string => Boolean(u))
        const candidates = direct ? [direct, ...sources] : sources.length ? sources : view.videoCount === 1 ? [...media] : []
        if (view.title && candidates.length && description && matchesShareDescription(description, view.title)) finish({id, desc: view.title, author: view.author, cover: httpUrl(view.poster), videoUrl: candidates[0], videoUrls: candidates})
      } catch { /* 导航过程中暂时没有文档，等待下一次检查 */ }
      finally { polling = false }
    }
    timer = setInterval(() => { void inspect() }, 750)
    wc.on('dom-ready', () => { void inspect() })
    void win.loadURL(shareUrl && isDouyinUrl(shareUrl) && !douyinPostId(shareUrl) ? shareUrl : `https://www.douyin.com/video/${id}`).catch(error => {
      if (!done && error?.code !== 'ERR_ABORTED') finish(undefined, new Error(`抖音页面无法加载：${error.message}`))
    })
  })
}
