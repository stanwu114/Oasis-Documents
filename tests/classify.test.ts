/** 六分类回归（含 R25：.ts 归代码不归视频） */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyExt } from '../src/shared/classify.ts'

test('图片', () => assert.equal(classifyExt('.jpg'), 'image'))
test('HEIC 归图片', () => assert.equal(classifyExt('.heic'), 'image'))
test('视频', () => assert.equal(classifyExt('.mp4'), 'video'))
test('R25: .ts 是 TypeScript 代码不是 MPEG-TS', () => assert.equal(classifyExt('.ts'), 'document'))
test('图纸', () => assert.equal(classifyExt('.dwg'), 'drawing'))
test('音频', () => assert.equal(classifyExt('.mp3'), 'audio'))
test('WPS 归文档', () => assert.equal(classifyExt('.wps'), 'document'))
test('未知归其他', () => assert.equal(classifyExt('.zhdl'), 'other'))
