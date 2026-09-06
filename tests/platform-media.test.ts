import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import sharp from 'sharp'
import { loadPlatform } from './load-platform.cjs'
const { extractXhsNote, xhsMedia } = loadPlatform('xhs-data')
const { embeddedState } = loadPlatform('page-data')
const { downloadMedia, downloadMediaCandidates } = loadPlatform('media-download')

test('小红书 SSR undefined 可解析，正文中的 undefined/括号不被替换', () => {
  const html = `<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"abc":{"note":{"title":"undefined { 转义\\\" }","desc":"正文","imageList":[{"infoList":[{"imageScene":"WB_DFT","url":"https://example.com/original.webp"}]}]}}}},"missing":undefined};window.other={};</script>`
  const note = extractXhsNote(html, 'abc')
  assert.equal(note.title, 'undefined { 转义" }')
  assert.deepEqual(xhsMedia(note).imageUrls, ['https://example.com/original.webp'])
  assert.equal(extractXhsNote(html, 'wrong'), null)
})
test('小红书视频与封面都提取；不执行页面脚本', () => {
  assert.deepEqual(xhsMedia({imageList: [{urlDefault: 'https://example.com/cover.jpg'}], video: {media: {stream: {h264: [{masterUrl: 'https://example.com/video.mp4'}]}}}}), {imageUrls: ['https://example.com/cover.jpg'], videoUrl: 'https://example.com/video.mp4'})
  assert.equal(embeddedState('<script>window.__INITIAL_STATE__={"x":process.exit()};</script>', '__INITIAL_STATE__'), null)
})
test('媒体流式下载：保留小图片，拒绝 HTML，取消清理临时文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oasis-media-test-'))
  const png = await sharp({create: {width: 8, height: 8, channels: 3, background: 'red'}}).png().toBuffer()
  const server = createServer((request, response) => {
    if (request.url === '/image') { response.setHeader('content-type', 'application/octet-stream'); response.end(png) }
    else if (request.url === '/slow') { response.writeHead(200); response.write(png.subarray(0, 5)) }
    else { response.setHeader('content-type', 'image/jpeg'); response.end('<html>login required</html>') }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as {port: number}
  const base = `http://127.0.0.1:${address.port}`
  try {
    const path = await downloadMedia(`${base}/image`, join(dir, 'image'), 'image', {})
    assert.equal(path, join(dir, 'image.png'))
    assert.deepEqual(await readFile(path), png)
    await assert.rejects(downloadMedia(`${base}/error`, join(dir, 'bad'), 'image', {}))
    await assert.rejects(downloadMedia(`${base}/error`, join(dir, 'bad-video'), 'video', {}))
    await assert.rejects(downloadMedia(`${base}/slow`, join(dir, 'slow'), 'image', {}, AbortSignal.timeout(100)))
    assert.deepEqual(await readdir(dir), ['image.png'])
    const fallback = await downloadMediaCandidates([`${base}/error`, `${base}/image`], join(dir, 'fallback'), 'image', {})
    assert.deepEqual(await readFile(fallback), png)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, {recursive: true, force: true})
  }
})

