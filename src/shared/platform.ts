/* ================================================================
   平台标识 → 展示名（我的收藏侧栏分组与卡片徽标共用）
   platform 字段两类取值:
   - 专用解析器的枚举:xiaohongshu / douyin / wechat-mp / csdn …
   - 通用导入的站点 host:www.tiktok.com / www.taobao.com …
   未映射的 host 去掉 www. 前缀直接展示域名
   ================================================================ */

const LABELS: Record<string, string> = {
  xiaohongshu: '小红书',
  douyin: '抖音',
  'wechat-mp': '微信',
  csdn: 'CSDN',
  weibo: '微博',
  bilibili: '哔哩哔哩',
  'www.tiktok.com': 'TikTok',
  'tiktok.com': 'TikTok',
  'www.taobao.com': '淘宝',
  'taobao.com': '淘宝',
  'item.taobao.com': '淘宝',
  'detail.tmall.com': '淘宝',
  'www.jd.com': '京东',
  'github.com': 'GitHub',
  'www.zhihu.com': '知乎',
  'zhihu.com': '知乎'
}

export function platformLabel(p: string): string {
  const hit = LABELS[p]
  if (hit) return hit
  return p.replace(/^https?:\/\//, '').replace(/^www\./, '')
}
