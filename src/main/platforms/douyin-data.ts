import { embeddedState, httpUrl } from './page-data'

export interface DyParsed {
  id?: string
  desc?: string
  author?: string
  cover?: string
  videoUrl?: string
  videoUrls?: string[]
  images?: string[]
}

type Dict = Record<string, unknown>
const object = (value: unknown): Dict => value && typeof value === 'object' && !Array.isArray(value) ? value as Dict : {}
const text = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
function addresses(value: unknown): string[] {
  const data = object(value)
  return [value, ...list(data.url_list ?? data.urlList), data.url].map(httpUrl).filter((url): url is string => Boolean(url))
}
function normalize(item: Dict): DyParsed | null {
  const video = object(item.video)
  const images = list(item.images ?? object(item.imagePostInfo).images).map(image => {
    const img = object(image)
    return addresses(image)[0] ?? addresses(img.display_image ?? img.displayImage)[0] ?? list(img.download_url_list).map(httpUrl).find(Boolean)
  }).filter((url): url is string => Boolean(url))
  const bitrates = list(video.bit_rate ?? video.bitRate).map(object)
  // 优先 H.264，避免把平台最高码率的 HEVC 地址作为唯一播放选择。
  bitrates.sort((a, b) => Number(Boolean(a.is_h265 ?? a.isH265)) - Number(Boolean(b.is_h265 ?? b.isH265)))
  const raw = [...addresses(video.play_addr ?? video.playAddr), ...bitrates.flatMap(rate => addresses(rate.play_addr ?? rate.playAddr)), ...addresses(video.download_addr ?? video.downloadAddr)]
  const uri = text(object(video.play_addr ?? video.playAddr).uri) ?? text(object(bitrates[0]?.play_addr).uri)
  const candidates = [...new Set([...raw.map(url => url.replace('/playwm/', '/play/')), ...raw, ...(uri ? [`https://www.douyin.com/aweme/v1/play/?video_id=${encodeURIComponent(uri)}&ratio=1080p&line=0`] : [])])]
  if (!images.length && !candidates.length) return null
  const author = item.author ?? item.authorInfo ?? item.avatarInfo
  return {
    id: text(item.aweme_id ?? item.awemeId ?? item.item_id ?? item.itemId),
    desc: text(item.desc) ?? text(item.title),
    author: text(author) ?? text(object(author).nickname),
    cover: addresses(video.origin_cover ?? video.originCover)[0] ?? addresses(video.cover)[0],
    // 图集中的 video 字段可能只是背景音乐的容器，不当作帖子视频下载。
    videoUrl: images.length ? undefined : candidates[0],
    videoUrls: images.length ? undefined : candidates,
    images: images.length ? images : undefined
  }
}

/** 同一响应可有推荐作品，必须按目标作品编号挑选，禁止抓错帖子。 */
export function extractDouyinData(root: unknown, expectedId?: string): DyParsed | null {
  const queue: unknown[] = [root]
  const candidates: DyParsed[] = []
  for (let index = 0; index < queue.length && index < 10000; index++) {
    const value = queue[index]
    if (!value || typeof value !== 'object') continue
    const item = object(value)
    if (item.video || item.images || item.imagePostInfo) {
      const parsed = normalize(item)
      if (parsed) {
        if (expectedId && parsed.id === expectedId) return parsed
        candidates.push(parsed)
      }
    }
    if (queue.length < 10000) queue.push(...Object.values(value).filter(v => v && typeof v === 'object').slice(0, 10000 - queue.length))
  }
  if (expectedId) return candidates.length === 1 && !candidates[0].id ? candidates[0] : null
  return candidates.length === 1 ? candidates[0] : null
}

export function extractRouterData(html: string, expectedId?: string): DyParsed | null {
  for (const marker of ['_ROUTER_DATA', 'RENDER_DATA', '__INITIAL_STATE__', '__NEXT_DATA__']) {
    const result = extractDouyinData(embeddedState(html, marker), expectedId)
    if (result) return result
  }
  return null
}
