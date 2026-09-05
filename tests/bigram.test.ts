/** FTS bigram 分词回归 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toBigrams } from '../src/main/bigram.ts'

test('中文切二元', () => assert.equal(toBigrams('向量数据库'), '向量 量数 数据 据库'))
test('单个汉字保留', () => assert.equal(toBigrams('图'), '图'))
test('英文整词保留', () => assert.equal(toBigrams('vector database'), 'vector database'))
test('中英混合', () => assert.match(toBigrams('向量db'), /向量/))
test('空串', () => assert.equal(toBigrams(''), ''))
test('引号剥离', () => assert.equal(toBigrams('"hello"'), 'hello'))
