/* ================================================================
   抖音分享页路由数据提取(纯函数,无 db/electron 依赖,可单测)
   - _ROUTER_DATA 是明文 JSON;RENDER_DATA 是 URL 编码 JSON
   - 不能先 decodeURIComponent:正文含独立 % 会抛 URIError 静默失败
   - play_addr.url_list 可能为空,需用 uri 拼免签名播放地址
   ================================================================ */

export interface DyParsed {
  desc?: string
  author?: string
  cover?: string
  videoUrl?: string
  images?: string[]
}

interface DyAddr {
  uri?: string
  url_list?: string[]
}
interface DyVideoItem {
  desc?: string
  author?: { nickname?: string } | string
  avatarInfo?: { nickname?: string }
  video?: {
    cover?: DyAddr
    originCover?: DyAddr
    play_addr?: DyAddr
    bit_rate?: { play_addr?: DyAddr }[]
  }
  images?: { url_list?: string[]; download_url_list?: string[] }[]
}

export function extractRouterData(html: string): DyParsed | null {
  for (const marker of ['_ROUTER_DATA', 'RENDER_DATA']) {
    const markerAt = html.indexOf(marker)
    if (markerAt < 0) continue
    const scriptEnd = html.indexOf('</script>', markerAt)
    const afterMarker = html.slice(markerAt, scriptEnd < 0 ? html.length : scriptEnd)
    const start = afterMarker.indexOf('{')
    const end = afterMarker.lastIndexOf('}')
    if (start < 0 || end <= start) continue
    const body = afterMarker.slice(start, end + 1)

    /* 先按明文 JSON 解析;失败再试 URL 解码(RENDER_DATA 风格)。
       顺序不能反:decodeURIComponent 遇到正文里独立的 % 会抛 URIError */
    let obj: unknown
    try {
      obj = JSON.parse(body)
    } catch {
      try {
        obj = JSON.parse(decodeURIComponent(body))
      } catch {
        continue
      }
    }

    const loader = ((obj as Record<string, unknown>).loaderData ?? obj) as Record<string, unknown>
    const page = Object.values(loader).find((v) => v && typeof v === 'object') as Record<string, unknown> | undefined
    const info = (page?.videoInfoRes ?? page?.item_list ?? page) as Record<string, unknown> | undefined
    if (!info) continue
    const list = (info.item_list ?? []) as DyVideoItem[]
    const item: DyVideoItem = list[0] ?? (info.video as DyVideoItem | undefined) ?? (info as unknown as DyVideoItem)
    const author = item.author ?? item.avatarInfo

    const pickHttp = (a?: DyAddr): string | undefined =>
      a?.url_list?.find((u) => typeof u === 'string' && u.startsWith('http'))

    /* 视频直链:bit_rate 首档(最高清)优先 → play_addr → uri 拼免签名地址 */
    const rawVideo = pickHttp(item.video?.bit_rate?.[0]?.play_addr) ?? pickHttp(item.video?.play_addr)
    const uri = item.video?.play_addr?.uri ?? item.video?.bit_rate?.[0]?.play_addr?.uri
    const videoUrl =
      rawVideo?.replace('/playwm/', '/play/') ??
      (typeof uri === 'string' && uri.length > 0
        ? `https://www.douyin.com/aweme/v1/play/?video_id=${uri}&ratio=1080p&line=0`
        : undefined)

    /* 图集:url_list 空时回退 download_url_list */
    const images = (item.images ?? [])
      .map(
        (img) =>
          img.url_list?.find((u) => typeof u === 'string' && u.startsWith('http')) ??
          img.download_url_list?.[0]
      )
      .filter((u): u is string => typeof u === 'string' && u.startsWith('http'))

    return {
      desc: typeof item.desc === 'string' ? item.desc : undefined,
      author: typeof author === 'string' ? author : author?.nickname,
      cover: item.video?.originCover?.url_list?.[0] ?? item.video?.cover?.url_list?.[0] ?? undefined,
      videoUrl: videoUrl || undefined,
      images: images.length > 0 ? images : undefined
    }
  }
  return null
}
