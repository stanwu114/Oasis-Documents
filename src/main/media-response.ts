import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { lookup } from 'mime-types'

/** 自定义媒体协议显式处理 Range；file:// 转发不保证支持大视频跳播。 */
export async function localMediaResponse(path: string, request: Request): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, {status: 405})
  try {
    const info = await stat(path)
    if (!info.isFile()) return new Response(null, {status: 404})
    const size = info.size
    const headers = new Headers({'Content-Type': lookup(path) || 'application/octet-stream', 'Accept-Ranges': 'bytes'})
    let start = 0, end = size - 1, status = 200
    const range = request.headers.get('Range')
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range)
      if (!match || (!match[1] && !match[2])) return new Response(null, {status: 416, headers: {'Content-Range': `bytes */${size}`}})
      if (!match[1]) start = Math.max(0, size - Number(match[2]))
      else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return new Response(null, {status: 416, headers: {'Content-Range': `bytes */${size}`}})
      status = 206
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
    }
    headers.set('Content-Length', String(Math.max(0, end - start + 1)))
    const body = request.method === 'HEAD' || !size ? null : Readable.toWeb(createReadStream(path, {start, end, signal: request.signal})) as ReadableStream<Uint8Array>
    return new Response(body, {status, headers})
  } catch { return new Response(null, {status: 404}) }
}
