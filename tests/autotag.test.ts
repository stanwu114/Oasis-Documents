/** 本地打标回归：频次 + 标题加权 + 合并去重 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoTag, mergeTags } from '../src/main/autotag.ts'

test('高频词被抽取', () => {
  const tags = autoTag('装修预算', '装修 装修 装修 预算 水电 水电 客厅')
  assert.equal(tags.includes('装修'), true)
})
test('标题加权优先', () => {
  const tags = autoTag('标题里的词', '正文 正文 正文 其他')
  /* n-gram 近似：标题词的片段应排首位 */
  assert.match(tags[0], /标题/)
})
test('mergeTags 去重且 AI 优先', () => {
  const m = mergeTags(['机器学习'], ['机器学习', '深度学习'])
  assert.deepEqual(m, ['机器学习', '深度学习'])
})
