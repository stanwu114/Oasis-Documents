/* ================================================================
   检索评分纯函数(无 electron / db 依赖,可单测)
   - 距离 → 余弦相似度换算
   - 相关性下限:绝对底线 + 相对头部窗口(弱命中不再凑数)
   - 图片意图识别(只影响排序,不丢结果)
   - 关键词通道伪分:标题命中 > 正文命中,按位次衰减
   ================================================================ */

export interface ScoredHit {
  id: string
  score: number
}

/**
 * LanceDB L2 距离(平方欧氏)→ 余弦相似度。
 * 向量入库前均已归一化:‖a-b‖² = 2 - 2·cos ⇒ cos = 1 - d/2。
 * 即使底层实现改为带根号的 L2,该函数仍保持单调递减,排序不受影响,
 * 只有绝对分数标度变化(阈值在 search.ts 统一调参)。
 */
export function cosFromDistance(d: number): number {
  return Math.max(0, Math.min(1, 1 - d / 2))
}

/**
 * 相关性下限过滤:先剔掉绝对底线以下的命中,再只保留头部分数窗口内的簇。
 * 目的:库里没有真正相关内容时宁可少给,不用弱命中凑满名额。
 * @param absFloor  绝对底线(余弦),低于此直接丢弃
 * @param relWindow 相对窗口,保留 score ≥ top - relWindow 的命中
 */
export function applyFloors(hits: ScoredHit[], absFloor: number, relWindow: number): ScoredHit[] {
  const sorted = [...hits].sort((a, b) => b.score - a.score)
  const kept = sorted.filter((h) => h.score >= absFloor)
  if (kept.length === 0) return []
  const top = kept[0].score
  return kept.filter((h) => h.score >= top - relWindow)
}

/** 图片意图查询:命中则图片结果优先排序(仅排序,不丢弃文本结果) */
export function looksLikeImageQuery(q: string): boolean {
  const t = q.trim()
  if (!t) return false
  if (
    /(架构图|流程图|示意图|拓扑图|效果图|原型图|图表|图片|图像|照片|截图|海报|封面|插画|壁纸|头像|图标|logo|icon|photo|image|picture|diagram|chart)/i.test(
      t
    )
  ) {
    return true
  }
  /* "xx图""xx照" 结尾的中文短语 */
  return /[图照]$/.test(t)
}

/**
 * 关键词通道伪分:标题命中 > 正文命中,按位次衰减但有下限。
 * 桌面搜索心智:精确关键词命中是最强信号——标题命中(0.85 起)无论
 * 排位多靠后都不低于 0.76,整体压过语义通道实测余弦上限(≤0.75);
 * 正文命中 0.60 起、下限 0.42,与中等语义命中持平。
 */
export function keywordScore(rank: number, total: number, titleHit: boolean): number {
  const base = titleHit ? 0.85 : 0.6
  const floor = titleHit ? 0.76 : 0.42
  const decay = Math.max(floor / base, 1 - 0.35 * (rank / Math.max(1, total)))
  return Math.round(base * decay * 10000) / 10000
}

/** 多通道命中按 id 合并去重,同一内容取最高分(R21 语义:切片命中不叠加) */
export function mergeById(lists: ScoredHit[][]): ScoredHit[] {
  const m = new Map<string, number>()
  for (const list of lists) {
    for (const h of list) {
      const prev = m.get(h.id)
      if (prev === undefined || h.score > prev) m.set(h.id, h.score)
    }
  }
  return [...m.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
}
