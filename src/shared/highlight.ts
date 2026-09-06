/* ================================================================
   查询词元化 + 摘要窗口 + 高亮正则(Everything 式关键词高亮)
   主进程(search.ts 摘要定位)与渲染进程(SearchView 高亮)共用,
   纯函数无依赖,可单测。
   ================================================================ */

/**
 * 查询 → 词元:空白分词;3 字以上中文短语补二元词片
 * (FTS 检索即按二元 AND 命中,词片出现处就是实际命中处)。
 * 词元统一小写、按长度降序(长词优先,避免短语被短词元拆开)。
 */
export function tokenizeQuery(query: string): string[] {
  const base = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0)
  const out = new Set<string>(base)
  for (const t of base) {
    if (/[一-鿿]/.test(t) && t.length >= 3) {
      for (let i = 0; i + 2 <= t.length; i++) out.add(t.slice(i, i + 2))
    }
  }
  return [...out].sort((a, b) => b.length - a.length)
}

/** 正则元字符转义 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 高亮正则的内部模式串(长词元优先的交替分支)。
 * 使用方:new RegExp(`(${pattern})`, 'gi') — 捕获组使 split 后
 * 奇数位即命中片段。
 */
export function highlightPattern(query: string): string | null {
  const tokens = tokenizeQuery(query)
  if (tokens.length === 0) return null
  return tokens.map(escapeRegExp).join('|')
}

/**
 * Everything 式摘要窗口:围绕查询词元在正文中的最早出现位置截取,
 * 保证"命中处可见"——而不是永远截取正文开头。
 * 词元全部未命中(纯语义召回)时退化为开头截取。
 * @param tokens tokenizeQuery 的输出(已小写)
 */
export function makeQuerySnippet(text: string, tokens: string[], len = 120): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= len) return clean
  let idx = -1
  const lower = clean.toLowerCase()
  for (const t of tokens) {
    const i = lower.indexOf(t)
    if (i >= 0 && (idx < 0 || i < idx)) idx = i
  }
  if (idx < 0) return clean.slice(0, len) + '…'
  const start = Math.max(0, idx - Math.floor(len * 0.35)) /* 命中处偏前,后文多给一些 */
  const end = Math.min(clean.length, start + len)
  return (start > 0 ? '…' : '') + clean.slice(start, end) + (end < clean.length ? '…' : '')
}
