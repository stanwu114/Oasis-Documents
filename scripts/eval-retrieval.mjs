#!/usr/bin/env node
/* 9.2 检索评测基线（轻量版）：对当前库跑固定查询集，记录命中情况
   运行: node scripts/eval-retrieval.mjs [--query 自定义词]
   输出: 每条查询的 top-5（标题+分数），作为后续模型/参数调整的对照基线 */
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DB = join(homedir(), 'Library/Application Support/Oasis Documents/oasis-documents.db')

const DEFAULT_QUERIES = [
  '向量数据库',
  '语义检索',
  '装修',
  '项目方案',
  'meeting notes'
]

async function main() {
  const custom = process.argv.includes('--query') ? process.argv[process.argv.indexOf('--query') + 1] : null
  const queries = custom ? [custom] : DEFAULT_QUERIES
  const db = new Database(DB, { readonly: true })

  console.log('# 检索评测基线（FTS 关键词路）\n')
  for (const q of queries) {
    /* bigram 化（与应用内一致） */
    const grams = []
    for (const seg of q.match(/[\u4e00-\u9fff]+|[^\s\u4e00-\u9fff]+/g) ?? []) {
      if (/^[\u4e00-\u9fff]+$/.test(seg)) {
        if (seg.length === 1) grams.push(seg)
        else for (let i = 0; i < seg.length - 1; i++) grams.push(seg.slice(i, i + 2))
      } else grams.push(seg.replace(/["'*]/g, '').trim())
    }
    console.log(`\n## 「${q}」`)
    try {
      const match = grams.filter(Boolean).map((g) => `"${g}"`).join(' AND ')
      const rows = db
        .prepare(`SELECT c.title, c.type FROM contents_fts f JOIN contents c ON c.id = f.content_id WHERE contents_fts MATCH ? ORDER BY rank LIMIT 5`)
        .all(match)
      if (rows.length === 0) console.log('（无命中）')
      rows.forEach((r, i) => console.log(`${i + 1}. [${r.type}] ${String(r.title).slice(0, 50)}`))
    } catch (e) {
      console.log('（FTS 不可用:', e.message.slice(0, 60), '）')
      const like = `%${q.replace(/[%_]/g, '')}%`
      const rows = db
        .prepare(`SELECT title, type FROM contents WHERE title LIKE ? OR content LIKE ? LIMIT 5`)
        .all(like, like)
      rows.forEach((r, i) => console.log(`${i + 1}. [${r.type}] ${String(r.title).slice(0, 50)}`))
    }
  }
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM contents`).get()).n
  console.log(`\n> 库规模：${total} 条内容 · ${new Date().toISOString().slice(0, 10)}`)
}

main().catch((e) => { console.error(e.message); process.exit(1) })
