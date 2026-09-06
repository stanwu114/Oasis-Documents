/** N13 回归：切片不产生空片 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* embedding-pipeline 依赖 electron，测试用 esbuild 抽取 chunkText 源码执行 */
const src = readFileSync('src/main/indexer/embedding-pipeline.ts', 'utf8')
const m = src.match(/export function chunkText[\s\S]*?\n\}/)
if (!m) throw new Error('chunkText 源码未找到')
const dir = mkdtempSync(join(tmpdir(), 'chunk-'))
const f = join(dir, 'chunk.cjs')
/* TS 源码经 esbuild 转译为 CJS（依赖已在 devDependencies） */
const esbuild = require(join(process.cwd(), 'node_modules', 'esbuild'))
const js = esbuild.transformSync(m[0].replace('export function', 'function') + `\nmodule.exports = { chunkText }\n`, { loader: 'ts', format: 'cjs' })
writeFileSync(f, js.code)
const { chunkText } = require(f)

test('正常文本切片非空', () => {
  const chunks = chunkText('第一段落内容。\n\n第二段落内容。')
  assert.ok(chunks.length > 0)
  assert.ok(chunks.every((c) => c.text.length > 0))
})
test('超长单段硬切不产生空片（N13）', () => {
  const chunks = chunkText('字'.repeat(1000))
  assert.ok(chunks.length >= 2)
  assert.ok(chunks.every((c) => c.text.length > 0), `存在空片: ${JSON.stringify(chunks.map((c) => c.text.length))}`)
})
