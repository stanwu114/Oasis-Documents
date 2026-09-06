/// <reference lib="dom" />
import { douyinPostId } from './douyin-link'
import { matchesShareDescription } from './share-text'
import { httpUrl } from './page-data'
import type { DyParsed } from './douyin-data'

export interface AlbumView {
  url: string
  title?: string
  album?: { images: string[]; total: number }
}

/** 只接受当前作品的完整图集，避免混入推荐卡片或保存不完整轮播。 */
export function extractRenderedAlbum(view: AlbumView, id: string, description?: string): DyParsed | null {
  if (douyinPostId(view.url) !== id || !description || !view.title || !matchesShareDescription(description, view.title)) return null
  const album = view.album
  if (!album || !Number.isInteger(album.total) || album.total < 1 || album.total > 100) return null
  const images = [...new Set(album.images.map(httpUrl).filter((url): url is string => Boolean(url)))]
  if (images.length !== album.total) return null
  // 浏览器标签标题常被截断；匹配后保留更完整的分享正文。
  return { id, desc: description.length > view.title.length ? description : view.title, images }
}

/** 在浏览器中执行；不依赖站点混淆类名，也不读取页面账户数据。 */
export function inspectDouyinDocument() {
  const visible = (element: Element): boolean => Boolean(element.getClientRects().length) && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none'
  const verification = Array.from(document.querySelectorAll('body *')).some(element =>
    element.children.length === 0 && visible(element) && /请完成下方验证|拖动滑块|验证后继续/.test(element.textContent ?? ''))
  let album: {images: string[]; total: number} | undefined
  const counters = Array.from(document.querySelectorAll('body *')).filter(element => /^\s*\d+\s*\/\s*\d+\s*$/.test(element.textContent ?? '') && visible(element))
  for (const counter of counters) {
    const total = Number(counter.textContent!.split('/')[1])
    let parent = counter.parentElement
    for (let level = 0; parent && level < 5 && parent !== document.body; level++, parent = parent.parentElement) {
      const images = [...new Set(Array.from(parent.querySelectorAll('img')).map(img => img.currentSrc || img.src).filter(url => url.includes('tplv-dy-aweme-images')))]
      if (images.length === total && total > 0) { album = {images, total}; break }
      if (images.length > total) break
    }
    if (album) break
  }
  const videos = Array.from(document.querySelectorAll('video'))
  const video = videos.length === 1 ? videos[0] : null
  return {verification, album, url: location.href,
    title: document.querySelector('h1')?.textContent?.trim() || (album ? document.title.replace(/\s*[-–]\s*抖音\s*$/, '').trim() : undefined),
    author: document.querySelector('[data-e2e="video-author-name"]')?.textContent?.trim(),
    src: video?.currentSrc || video?.src, poster: video?.poster,
    sources: video ? Array.from(video.querySelectorAll('source')).map(s => s.src) : [], videoCount: videos.length,
    html: Array.from(document.querySelectorAll('script')).filter(s => /RENDER_DATA|_ROUTER_DATA|__INITIAL_STATE__|__NEXT_DATA__/.test(s.id + (s.textContent ?? '').slice(0, 100))).map(s => s.outerHTML).join('').slice(0, 8000000)}
}
