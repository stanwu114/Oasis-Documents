/** 抖音分享页路由数据提取回归(明文 JSON/百分号/uri 兜底/图集回退) */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractRouterData } from '../src/main/platforms/douyin-data.ts'

function page(json: string): string {
  return `<html><body><script>window._ROUTER_DATA = ${json}</script></body></html>`
}

test('明文 JSON 解析:视频直链 playwm→play 去水印', () => {
  const html = page(
    JSON.stringify({
      loaderData: {
        'video_(id)/page': {
          videoInfoRes: {
            item_list: [
              {
                desc: '看看这段 #旅行',
                author: { nickname: '小明' },
                video: {
                  originCover: { url_list: ['https://p3.douyinpic.com/cover.jpg'] },
                  play_addr: {
                    uri: 'v0d00fg10000c01f8m4c77u1o1k0gb00',
                    url_list: ['https://www.douyin.com/aweme/v1/playwm/?video_id=v0d00fg10000c01f8m4c77u1o1k0gb00&ratio=720p&line=0']
                  }
                }
              }
            ]
          }
        }
      }
    })
  )
  const r = extractRouterData(html)
  assert.ok(r, '应解析出数据')
  assert.equal(r?.author, '小明')
  assert.ok(r?.videoUrl?.includes('/play/'), 'playwm 应替换为 play')
  assert.ok(!r?.videoUrl?.includes('playwm'))
  assert.equal(r?.cover, 'https://p3.douyinpic.com/cover.jpg')
})

test('正文含独立 % 字符不再炸(先按明文 JSON 解析)', () => {
  const html = page(
    JSON.stringify({
      loaderData: {
        'video_(id)/page': {
          videoInfoRes: {
            item_list: [
              { desc: '充电 100% 满电出发', video: { play_addr: { uri: 'abc123', url_list: ['https://www.douyin.com/aweme/v1/playwm/?video_id=abc123'] } } }
            ]
          }
        }
      }
    })
  )
  const r = extractRouterData(html)
  assert.equal(r?.desc, '充电 100% 满电出发')
})

test('url_list 为空时用 uri 拼免签名播放地址', () => {
  const html = page(
    JSON.stringify({
      loaderData: {
        'video_(id)/page': {
          videoInfoRes: { item_list: [{ desc: 'x', video: { play_addr: { uri: 'v0200fg10000', url_list: [] } } }] }
        }
      }
    })
  )
  const r = extractRouterData(html)
  assert.ok(r?.videoUrl?.includes('video_id=v0200fg10000'), `实际: ${r?.videoUrl}`)
})

test('图集:url_list 空回退 download_url_list,取全部图', () => {
  const html = page(
    JSON.stringify({
      loaderData: {
        'note_(id)/page': {
          videoInfoRes: {
            item_list: [
              {
                desc: '图集',
                images: [
                  { url_list: ['https://p3.douyinpic.com/a.jpg'] },
                  { url_list: [], download_url_list: ['https://p9.douyinpic.com/b.jpg'] }
                ]
              }
            ]
          }
        }
      }
    })
  )
  const r = extractRouterData(html)
  assert.deepEqual(r?.images, ['https://p3.douyinpic.com/a.jpg', 'https://p9.douyinpic.com/b.jpg'])
})

test('无路由数据返回 null(RENDER_DATA 兜底路径)', () => {
  assert.equal(extractRouterData('<html>empty</html>'), null)
})
