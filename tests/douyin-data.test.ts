/** 抖音分享页路由数据提取回归(明文 JSON/百分号/uri 兜底/图集回退) */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlatform } from './load-platform.cjs'
const { extractRouterData } = loadPlatform('douyin-data')

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

 test('URL 编码的 RENDER_DATA 和非首个 loader 节点也能解析', () => {
  const payload = {loaderData: {layout: {user: {}}, detail: {aweme_detail: {desc: '100% 完整', images: [{url_list: ['https://example.com/a.jpg']}]}}}}
  const html = `<script id="RENDER_DATA" type="application/json">${encodeURIComponent(JSON.stringify(payload))}</script>`
  assert.deepEqual(extractRouterData(html)?.images, ['https://example.com/a.jpg'])
  assert.equal(extractRouterData(html)?.desc, '100% 完整')
})

test('按作品编号选择目标，不能把推荐视频当成收藏', () => {
  const payload = {recommend: {aweme_id: '1111111111111111111', desc: '推荐', video: {play_addr: {url_list: ['https://example.com/wrong.mp4']}}}, detail: {aweme_id: '7675581342318447907', desc: '目标', video: {play_addr: {url_list: ['https://example.com/right.mp4']}}}}
  assert.equal(extractRouterData(page(JSON.stringify(payload)), '7675581342318447907')?.desc, '目标')
  assert.equal(extractRouterData(page(JSON.stringify(payload)), '2222222222222222222'), null)
})
test('桌面 camelCase 视频数据、备用地址与空节点', () => {
  const payload = {empty:{images:[]},detail:{awemeId:'7675581342318447907',desc:'DIY',authorInfo:{nickname:'作者'},video:{playAddr:{urlList:['https://example.com/a.mp4','https://example.com/b.mp4']},originCover:{urlList:['https://example.com/cover.jpg']}}}}
  const result = extractRouterData(`<script id="RENDER_DATA">${encodeURIComponent(JSON.stringify(payload))}</script>`, '7675581342318447907')
  assert.equal(result?.author,'作者')
  assert.equal(result?.cover,'https://example.com/cover.jpg')
  assert.deepEqual(result?.videoUrls,['https://example.com/a.mp4','https://example.com/b.mp4'])
})
test('图集不下载 video 字段里的背景音频', () => {
  const result = extractRouterData(page(JSON.stringify({images:[{url_list:['https://example.com/a.jpg']}],video:{play_addr:{url_list:['https://example.com/music.mp4']}}})))
  assert.deepEqual(result?.images,['https://example.com/a.jpg'])
  assert.equal(result?.videoUrl,undefined)
})
