/** R02 回归：目录边界精确匹配（work 不得误删 work-old） */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isUnderRoot } from '../src/main/path-boundary.ts'

test('子文件在边界内', () => assert.equal(isUnderRoot('/a/work/x.pdf', '/a/work'), true))
test('根本身在边界内', () => assert.equal(isUnderRoot('/a/work', '/a/work'), true))
test('相邻前缀目录不在边界内（R02 核心）', () => assert.equal(isUnderRoot('/a/work-old/x', '/a/work'), false))
test('同前缀单词不在边界内', () => assert.equal(isUnderRoot('/a/worker/x', '/a/work'), false))
test('更短前缀不在边界内', () => assert.equal(isUnderRoot('/a/wo/x', '/a/work'), false))
test('null 路径不在边界内', () => assert.equal(isUnderRoot(null, '/a/work'), false))
