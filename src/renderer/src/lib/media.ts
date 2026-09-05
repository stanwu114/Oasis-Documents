/* 本地图片路径 → 媒体协议 URL
   dev 模式页面来源是 http://localhost，Chromium 禁止直接加载 file://，
   统一走主进程注册的 oasis-media:// 协议（带目录白名单） */

export function toMediaUrl(path: string | null | undefined): string | null {
  if (!path) return null
  /* 缩略图：…/media/thumbnails/<name> */
  const thumb = path.match(/[/\\]media[/\\]thumbnails[/\\](.+)$/)
  if (thumb) return `oasis-media://thumb/${encodeURIComponent(thumb[1])}`
  /* 媒体目录其他内容：…/media/<sub…> */
  const media = path.match(/[/\\]media[/\\](.+)$/)
  if (media) {
    const rel = media[1].split(/[/\\]/).map(encodeURIComponent).join('/')
    return `oasis-media://media/${rel}`
  }
  /* 任意图片绝对路径（以图搜图预览等） */
  return `oasis-media://raw?p=${encodeURIComponent(path)}`
}
