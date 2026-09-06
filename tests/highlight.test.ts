/** 关键词高亮/摘要窗口回归(以文搜文 Everything 式) */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tokenizeQuery, highlightPattern, makeQuerySnippet, escapeRegExp } from '../src/shared/highlight.ts'

test('分词:空白多词 + 小写化(长度降序,同长保持输入序)', () => {
  assert.deepEqual(tokenizeQuery('报销 流程 Report'), ['report', '报销', '流程'])
})

test('分词:中文短语补二元词片,长词优先', () => {
  const t = tokenizeQuery('架构图')
  assert.ok(t[0] === '架构图')
  assert.ok(t.includes('架构') && t.includes('构图'))
})

test('分词:两字中文词不重复补片', () => {
  assert.deepEqual(tokenizeQuery('架构'), ['架构'])
})

test('高亮模式串:元字符转义,长词优先', () => {
  assert.ok(highlightPattern('架构图')?.startsWith('架构图|'))
  const p = highlightPattern('架构图 (C++)')
  assert.ok(p)
  assert.ok(p.includes('架构图'))
  assert.ok(p.includes('\\(c\\+\\+\\)'))
  assert.equal(highlightPattern('  '), null)
})

test('转义:正则特殊字符安全', () => {
  assert.equal(escapeRegExp('a.b*c'), 'a\\.b\\*c')
})

test('摘要:命中处可见,带省略号', () => {
  const body = '前文'.repeat(80) + '本系统的架构图展示了分层设计' + '后文'.repeat(80)
  const s = makeQuerySnippet(body, tokenizeQuery('架构图'))
  assert.ok(s.includes('架构图'))
  assert.ok(s.startsWith('…'))
  assert.ok(s.endsWith('…'))
})

test('摘要:二元词片兜底命中(正文只有"架构"没有"架构图")', () => {
  const body = '开头段落。' + '无关'.repeat(60) + '这里讲述系统架构分层' + '结尾'.repeat(60)
  const s = makeQuerySnippet(body, tokenizeQuery('架构图'))
  assert.ok(s.includes('架构'))
})

test('摘要:未命中退化为开头截取;短文本原样返回', () => {
  assert.equal(makeQuerySnippet('完全无关的正文', tokenizeQuery('架构图')), '完全无关的正文')
  const long = '甲'.repeat(300)
  const s = makeQuerySnippet(long, tokenizeQuery('架构图'))
  assert.ok(s.startsWith('甲') && s.endsWith('…') && s.length <= 122)
})

test('摘要:英文大小写不敏感命中', () => {
  const body = 'intro '.repeat(40) + 'the Deployment Guide covers architecture ' + 'tail '.repeat(40)
  const s = makeQuerySnippet(body, tokenizeQuery('deployment'))
  assert.ok(s.toLowerCase().includes('deployment'))
})
