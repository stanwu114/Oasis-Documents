/* bigram 分词（无外部依赖，供 FTS 与测试使用） */

/** 文本 → bigram 分词后的空格分隔串 */
export function toBigrams(text: string): string {
  if (!text) return ''
  const out: string[] = []
  /* 按中/非中分段 */
  for (const seg of text.match(/[\u4e00-\u9fff]+|[^\s\u4e00-\u9fff]+/g) ?? []) {
    if (/^[\u4e00-\u9fff]+$/.test(seg)) {
      if (seg.length === 1) out.push(seg)
      else for (let i = 0; i < seg.length - 1; i++) out.push(seg.slice(i, i + 2))
    } else {
      /* 英文数字词原样（unicode61 自行切分），去掉控制字符 */
      out.push(seg.replace(/["'*]/g, ' ').trim())
    }
  }
  return out.filter(Boolean).join(' ')
}
