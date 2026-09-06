import { useLayoutEffect, useRef, useState } from 'react'

/* ================================================================
   绝对定位瀑布流（替代 CSS columns——后者在图片懒加载高度变化时
   会重排错位/交叉）。最矮列分配算法；图片 onLoad 拿真实比例后
   精确重排，布局永不交叉。
   ================================================================ */

interface MasonryItem {
  key: string
  /** 预估高度（图片未加载时的占位）；不传则用 imgRatio 估算 */
  estimate?: number
  /** 有图卡片的宽高比预估（w/h），默认 4/3 */
  ratio?: number
}

const GAP = 14
const BODY_H = 66 /* 卡片文字区固定高度（标题两行 + meta + padding） */
const MIN_COL_W = 210

export function MasonryGrid({
  items,
  render,
  hasImage
}: {
  items: MasonryItem[]
  /** 渲染卡片内容；onImageLoad 需绑到内部 img 的 onLoad */
  render: (item: MasonryItem, onImageLoad: (el: HTMLImageElement) => void, style: React.CSSProperties) => React.ReactNode
  /** 卡片是否含图（无图用固定占位高度） */
  hasImage: (item: MasonryItem) => boolean
}): React.ReactNode {
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerW, setContainerW] = useState(0)
  const [ratios, setRatios] = useState<Record<string, number>>({}) /* key → 实际 w/h */

  /* 容器宽度响应 */
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      setContainerW(entries[0].contentRect.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const cols = Math.max(2, Math.min(6, Math.floor(containerW / MIN_COL_W) || 4))
  const colW = containerW > 0 ? (containerW - GAP * (cols - 1)) / cols : 0

  /* 卡片高度：有图按（已知或估算的）宽高比，无图固定 */
  const cardH = (item: MasonryItem): number => {
    if (!hasImage(item)) return 150 + BODY_H
    const ratio = ratios[item.key] ?? item.ratio ?? 4 / 3
    return colW / ratio + BODY_H
  }

  /* 最矮列分配 */
  const positions: { key: string; style: React.CSSProperties }[] = []
  let maxBottom = 0
  if (colW > 0) {
    const colHeights = new Array(cols).fill(0)
    for (const item of items) {
      let minCol = 0
      for (let c = 1; c < cols; c++) {
        if (colHeights[c] < colHeights[minCol]) minCol = c
      }
      const top = colHeights[minCol]
      const left = minCol * (colW + GAP)
      const h = cardH(item)
      positions.push({
        key: item.key,
        style: { position: 'absolute', left, top, width: colW, height: h }
      })
      colHeights[minCol] = top + h + GAP
      maxBottom = Math.max(maxBottom, colHeights[minCol])
    }
  }

  const onImageLoad = (el: HTMLImageElement): void => {
    if (!el.naturalWidth || !el.naturalHeight) return
    const key = el.getAttribute('data-mkey') ?? ''
    const r = el.naturalWidth / el.naturalHeight
    if (key && (ratios[key] === undefined || Math.abs(ratios[key] - r) > 0.01)) {
      setRatios((prev) => ({ ...prev, [key]: r }))
    }
  }

  return (
    <div ref={containerRef} className="masonry-abs" style={{ position: 'relative', height: maxBottom, width: '100%' }}>
      {positions.map((pos, i) => render(items[i], onImageLoad, pos.style))}
    </div>
  )
}
