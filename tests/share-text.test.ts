/** 分享文案解析回归 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseShareText, matchesShareDescription } from '../src/main/platforms/share-text.ts'

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

test('完整抖音分享文案保留口令和原文，提取干净描述与带空格的话题', () => {
  const raw='2.07 12/02 :8pm BGV:/ N@w.SY 生活中只要会一点DIY，真的打开装修信息差 # diy橱柜 # 定制橱柜 # 橱柜 # 开放式厨房 # 厨房收纳 [https://v.douyin.com/DT10kPoloAE/](https://v.douyin.com/DT10kPoloAE/) 复制此链接，打开Dou音搜索，直接观看视频！'
  const r=parseShareText(raw)
  assert.equal(r.rawText,raw)
  assert.equal(r.shareCode,'2.07 12/02 :8pm BGV:/ N@w.SY')
  assert.equal(r.url,'https://v.douyin.com/DT10kPoloAE/')
  assert.ok(r.text.startsWith('生活中只要会一点DIY'))
  assert.equal(r.text.includes('https:'),false)
  assert.equal(r.text.includes('复制此链接'),false)
  assert.deepEqual(r.hashtags,['diy橱柜','定制橱柜','橱柜','开放式厨房','厨房收纳'])
})

test('分享描述核对拒绝跳转后的推荐视频', () => {
  assert.equal(matchesShareDescription('生活中只要会一点DIY，真的打开装修信息差 # 橱柜', '生活中只要会一点DIY，真的打开装修信息差 #橱柜'),true)
  assert.equal(matchesShareDescription('生活中只要会一点DIY，真的打开装修信息差','我在亚洲最危险的城市生存了100小时'),false)
})
