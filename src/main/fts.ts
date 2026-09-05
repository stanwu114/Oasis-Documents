import { getDb } from './db'

/* ================================================================
   FTS5 中文全文检索：bigram 预分词方案
   - 中文连续段切二元（"向量数据库" → 向量 量数 数据 据库），
     英文/数字词保留整词，空格分隔喂给 unicode61 tokenizer
   - 查询同样转换，短语 AND 匹配；失败回退 LIKE
   ================================================================ */

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

/** 写入/更新一条内容的全文索引 */
export function ftsUpsert(contentId: string, title: string, body: string): void {
  const db = getDb()
  try {
    db.prepare(`DELETE FROM contents_fts WHERE content_id = ?`).run(contentId)
    db
      .prepare(`INSERT INTO contents_fts (content_id, title, body) VALUES (?, ?, ?)`)
      .run(contentId, toBigrams(title), toBigrams(body))
  } catch {
    /* FTS 表不存在（构建无 FTS5）时静默跳过，检索回退 LIKE */
  }
}

export function ftsDelete(contentId: string): void {
  try {
    getDb().prepare(`DELETE FROM contents_fts WHERE content_id = ?`).run(contentId)
  } catch {
    /* 同上 */
  }
}

/** 全文检索 → 内容 id 列表；不可用返回 null（调用方回退 LIKE） */
export function ftsSearch(query: string, limit: number): string[] | null {
  try {
    const db = getDb()
    const grams = toBigrams(query).split(' ').filter(Boolean)
    if (grams.length === 0) return []
    /* 每个 bigram 作为一个短语，AND 连接 */
    const match = grams.map((g) => `"${g.replace(/"/g, '""')}"`).join(' AND ')
    const rows = db
      .prepare(
        `SELECT content_id FROM contents_fts
         WHERE contents_fts MATCH ? ORDER BY rank LIMIT ?`
      )
      .all(match, limit) as { content_id: string }[]
    return rows.map((r) => r.content_id)
  } catch {
    return null
  }
}
