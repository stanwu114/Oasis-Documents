/** 检索评分纯函数回归(N20):换算、下限、意图、伪分、合并 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cosFromDistance,
  applyFloors,
  looksLikeImageQuery,
  keywordScore,
  mergeById
} from '../src/main/search-scoring.ts'

test('L2→余弦:距离 0 = 完全相似', () => {
  assert.equal(cosFromDistance(0), 1)
})

test('L2→余弦:正交向量 ≈ 0,钳制不出界', () => {
  assert.ok(Math.abs(cosFromDistance(2)) < 1e-9)
  assert.equal(cosFromDistance(99), 0)
  assert.equal(cosFromDistance(-5), 1)
})

test('下限:绝对底线剔除弱命中', () => {
  const hits = [
    { id: 'a', score: 0.7 },
    { id: 'b', score: 0.5 },
    { id: 'c', score: 0.1 }
  ]
  assert.deepEqual(
    applyFloors(hits, 0.3, 1).map((h) => h.id),
    ['a', 'b']
  )
})

test('下限:相对窗口只保留头部簇', () => {
  const hits = [
    { id: 'a', score: 0.75 },
    { id: 'b', score: 0.6 },
    { id: 'c', score: 0.35 },
    { id: 'd', score: 0.33 }
  ]
  /* 窗口 0.3:只留 ≥ 0.45 的 a、b */
  assert.deepEqual(
    applyFloors(hits, 0.3, 0.3).map((h) => h.id),
    ['a', 'b']
  )
})

test('下限:全部低于底线返回空(宁可少给不凑数)', () => {
  assert.deepEqual(applyFloors([{ id: 'x', score: 0.2 }], 0.3, 0.3), [])
})

test('图片意图:架构图/照片/截图/英文词命中', () => {
  assert.equal(looksLikeImageQuery('架构图'), true)
  assert.equal(looksLikeImageQuery('系统拓扑图'), true)
  assert.equal(looksLikeImageQuery('产品截图'), true)
  assert.equal(looksLikeImageQuery('logo 设计'), true)
  assert.equal(looksLikeImageQuery('architecture diagram'), true)
})

test('图片意图:普通查询不误伤', () => {
  assert.equal(looksLikeImageQuery('季度财务报表'), false)
  assert.equal(looksLikeImageQuery('报销流程'), false)
  assert.equal(looksLikeImageQuery(''), false)
})

test('关键词伪分:标题命中 > 正文命中,位次衰减单调,标题命中压过语义命中上限', () => {
  const title = keywordScore(0, 10, true)
  const body = keywordScore(0, 10, false)
  assert.ok(title > body)
  assert.ok(keywordScore(0, 10, false) > keywordScore(9, 10, false))
  /* 语义通道实测余弦 ≤0.75:标题命中(含衰减)必须整体压过它 */
  assert.ok(title <= 0.85 + 1e-9)
  assert.ok(keywordScore(9, 10, true) > 0.75)
  /* 正文命中与强语义命中持平 */
  assert.ok(body >= 0.6 - 1e-9 && body <= 0.6 + 1e-9)
})

test('合并:同 id 取最高分,跨通道去重', () => {
  const merged = mergeById([
    [
      { id: 'a', score: 0.4 },
      { id: 'b', score: 0.6 }
    ],
    [{ id: 'a', score: 0.65 }]
  ])
  assert.deepEqual(merged, [
    { id: 'a', score: 0.65 },
    { id: 'b', score: 0.6 }
  ])
})
