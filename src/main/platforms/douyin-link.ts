/** 桌面弹窗、App 分享页和短链统一识别；仅匹配抖音站点自身的主机名。 */
export function isDouyinUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return /^https?:$/.test(url.protocol) && /(^|\.)(douyin\.com|iesdouyin\.com)$/i.test(url.hostname)
  } catch { return false }
}

export function douyinPostId(value: string): string | undefined {
  if (!isDouyinUrl(value)) return undefined
  const url = new URL(value)
  const pathId = url.pathname.match(/\/(?:video|note|slides)\/(\d+)(?:\/|$)/)?.[1]
  const queryId = url.searchParams.get('modal_id') ?? url.searchParams.get('aweme_id') ?? url.searchParams.get('item_id')
  return pathId ?? (queryId && /^\d{10,25}$/.test(queryId) ? queryId : undefined)
}
