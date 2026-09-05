/** 分享文案解析回归 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseShareText } from '../src/main/platforms/share-text.ts'

test('抖音口令文案：提取链接并清噪音', () => {
  const r = parseShareText('7.98 pQg:/ 复制打开抖音，看看【装修日记】的作品 #极简风 https://v.douyin.com/iRNBho5y/ 复制此链接')
  assert.equal(r.url, 'https://v.douyin.com/iRNBho5y/')
  assert.equal(r.hashtags.includes('极简风'), true)
  assert.equal(r.text.includes('复制打开'), false)
})
test('小红书文案', () => {
  const r = parseShareText('奶油小方真的绝了 https://xhslink.com/a/AbCdEf123')
  assert.equal(r.url, 'https://xhslink.com/a/AbCdEf123')
  assert.match(r.text, /奶油小方/)
})
test('纯链接', () => {
  assert.equal(parseShareText('https://mp.weixin.qq.com/s/abc').url, 'https://mp.weixin.qq.com/s/abc')
})
test('裸域名补协议', () => {
  assert.equal(parseShareText('blog.csdn.net/x/article/details/1').url, 'https://blog.csdn.net/x/article/details/1')
})
test('无链接返回 null', () => {
  assert.equal(parseShareText('这段话没有链接').url, null)
})
