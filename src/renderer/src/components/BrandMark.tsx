/** Oasis 品牌标识（与 Oasis Meeting 同源）:
 *  主符号(o)为官方矢量套件(brand/oasis-vector)的 Q 形开放 O,
 *  内嵌 symbol.svg 同源几何(外椭圆 rx430/ry435 + 内孔 + 右下尾巴遮刻),自带品牌橙渐变。
 *  产品线图标用与官方符号同权重的闭口环(外 r20.25/内 r12.6),
 *  颜色跟随 currentColor,内部替换能力图形。
 *  documents 变体几何取自官方 oasis-document-app-icon.svg 的文档页母题(折角页 + 两行文字线)。 */

const SYMBOL = (
  <g transform="scale(0.046875)">
    <defs>
      <linearGradient id="bmOrange" x1="174" y1="122" x2="768" y2="894" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="#ff8f2d" />
        <stop offset="0.42" stopColor="#ff7300" />
        <stop offset="1" stopColor="#e44600" />
      </linearGradient>
      <mask id="bmCutout" maskUnits="userSpaceOnUse">
        <rect width="1024" height="1024" fill="white" />
        <ellipse cx="514" cy="512" rx="268" ry="269" fill="black" />
        <path
          d="M675 680 C728 776 837 828 937 810"
          fill="none"
          stroke="black"
          strokeWidth="57"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </mask>
    </defs>
    <g mask="url(#bmCutout)">
      <ellipse cx="512" cy="512" rx="430" ry="435" fill="url(#bmOrange)" />
    </g>
  </g>
)

/* 产品线闭口环:几何对应官方符号的环体(1024 系换算到 48) */
const RING = <circle cx="24" cy="24" r="16.4" strokeWidth="7.7" stroke="currentColor" fill="none" />

const VARIANTS: Record<string, React.ReactNode> = {
  /* 主品牌:Q 形开放 O(官方符号) */
  o: SYMBOL,
  /* Oasis Documents:环 + 文档页(折角 + 两行文字线,官方 app-icon 同源几何) */
  documents: (
    <>
      {RING}
      <g fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M19.8 18.4 H26 L29.2 21.6 V30.4 H19.8 Z" />
        <path d="M26 18.4 V21.6 H29.2" />
        <path d="M21.8 24 H27.2" />
        <path d="M21.8 27 H28" />
      </g>
    </>
  )
}

export function BrandMark({
  variant = 'o',
  size = 22,
  className
}: {
  variant?: 'o' | 'documents'
  size?: number
  className?: string
}): React.ReactNode {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 48 48"
      aria-hidden="true"
    >
      {VARIANTS[variant]}
    </svg>
  )
}
