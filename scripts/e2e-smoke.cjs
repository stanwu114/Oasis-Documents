#!/usr/bin/env node
/* 端到端冒烟（Node 环境，不需要 Electron 窗口）：
   1) sharp 生成测试图片  2) LanceDB 向量写入+检索  3) sha256 去重逻辑
   运行: node scripts/e2e-smoke.cjs
*/
const { createHash } = require('node:crypto')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-e2e-'))
  console.log('[1] 测试目录:', tmp)

  /* sharp 生成两张测试图片 */
  const sharp = require('sharp')
  await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 180, g: 83, b: 6 } } })
    .jpeg()
    .toFile(path.join(tmp, 'amber.jpg'))
  await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 22, g: 122, b: 62 } } })
    .jpeg()
    .toFile(path.join(tmp, 'green.jpg'))
  console.log('[2] sharp 生成图片 OK')

  /* 缩略图管线 */
  await sharp(path.join(tmp, 'amber.jpg')).resize({ width: 480 }).jpeg({ quality: 78 }).toFile(path.join(tmp, 'thumb.jpg'))
  const thumbSize = fs.statSync(path.join(tmp, 'thumb.jpg')).size
  assert(thumbSize > 1000 && thumbSize < fs.statSync(path.join(tmp, 'amber.jpg')).size, '缩略图应小于原图')
  console.log('[3] 缩略图管线 OK (%dB)', thumbSize)

  /* LanceDB 写入 + 检索 */
  const lancedb = require('@lancedb/lancedb')
  const db = await lancedb.connect(path.join(tmp, 'vectors'))
  const records = [
    { id: 'a', content_id: 'content-amber', vector: unit(512, 1), kind: 'image' },
    { id: 'b', content_id: 'content-green', vector: unit(512, 2), kind: 'image' },
    { id: 'c', content_id: 'content-blue', vector: unit(512, 3), kind: 'image' }
  ]
  await db.createTable('image_vectors', records)
  const table = await db.openTable('image_vectors')
  const hits = await table.search(unit(512, 1.02)).limit(2).toArray()
  assert(hits.length === 2, '应返回 2 条')
  assert(hits[0].content_id === 'content-amber', `最相近应为 amber，实际 ${hits[0].content_id}`)
  assert(hits[0]._distance < hits[1]._distance, '距离应升序')
  console.log(`[4] LanceDB 向量检索 OK (top1=${hits[0].content_id}, dist=${hits[0]._distance.toFixed(4)})`)

  /* sha256 一致性 */
  const h1 = hashFile(path.join(tmp, 'amber.jpg'))
  fs.copyFileSync(path.join(tmp, 'amber.jpg'), path.join(tmp, 'amber-copy.jpg'))
  assert(h1 === hashFile(path.join(tmp, 'amber-copy.jpg')), '相同文件哈希一致')
  assert(h1 !== hashFile(path.join(tmp, 'green.jpg')), '不同文件哈希不同')
  console.log('[5] SHA-256 去重判定 OK')

  /* 清理 */
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log('\n✅ 全部冒烟通过')
}

function unit(dim, seed) {
  const v = new Array(dim).fill(0).map((_, i) => Math.sin(seed + i * 0.01))
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0))
  return v.map((x) => x / norm)
}

function hashFile(p) {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex')
}

function assert(cond, msg) {
  if (!cond) {
    console.error('❌ 断言失败:', msg)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('❌ 冒烟失败:', e)
  process.exit(1)
})
