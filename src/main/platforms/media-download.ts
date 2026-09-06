import axios from 'axios'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import sharp from 'sharp'

/** 流式落盘；拒绝错误页，失败不留下半个文件。timeout 是整个下载期限。 */
export async function downloadMedia(url: string, destination: string, kind: 'image' | 'video', headers: Record<string, string>, signal?: AbortSignal): Promise<string> {
  const limit = (kind === 'video' ? 300 : 30) * 1024 * 1024
  const deadline = AbortSignal.any([AbortSignal.timeout(kind === 'video' ? 120_000 : 25_000), ...(signal ? [signal] : [])])
  const temporary = `${destination}.${crypto.randomUUID()}.part`
  await mkdir(dirname(destination), { recursive: true })
  try {
    const response = await axios.get(url, { headers, responseType: 'stream', signal: deadline, timeout: 20_000, maxRedirects: 5 })
    let size = 0
    const head: Buffer[] = []
    let headSize = 0
    const guard = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length
      if (headSize < 32) { head.push(chunk.subarray(0, 32 - headSize)); headSize += head[head.length - 1].length }
      callback(size > limit ? new Error('媒体超过下载大小限制') : null, chunk)
    } })
    await pipeline(response.data, guard, createWriteStream(temporary), { signal: deadline })
    if (!size) throw new Error('媒体为空')
    let extension: string
    if (kind === 'image') {
      const info = await sharp(temporary).metadata()
      if (!info.width || !info.height || !info.format) throw new Error('不是有效图片')
      extension = info.format === 'jpeg' ? 'jpg' : info.format
    } else {
      const bytes = Buffer.concat(head)
      extension = bytes.subarray(4, 8).toString() === 'ftyp' ? 'mp4' : bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) ? 'webm' : ''
      if (!extension) throw new Error('下载地址没有返回视频文件')
    }
    const path = `${destination}.${extension}`
    await rename(temporary, path)
    return path
  } finally {
    await rm(temporary, { force: true })
  }
}

/** 视频没有可下载封面时，从本地文件抽取首帧。 */
export async function videoThumbnail(videoPath: string): Promise<string | null> {
  const path = `${videoPath}.jpg`
  try {
    const binary = (await import('ffmpeg-static')).default
    if (!binary) return null
    const {execFile} = await import('node:child_process')
    await new Promise<void>((resolve, reject) => execFile(binary.replace('app.asar/', 'app.asar.unpacked/'), ['-y', '-i', videoPath, '-frames:v', '1', '-vf', 'scale=480:-2', path], {timeout: 15_000}, error => error ? reject(error) : resolve()))
    await sharp(path).metadata()
    return path
  } catch { await rm(path, {force: true}); return null }
}

/** 同一媒体的备用 CDN 地址共用总时限，最多尝试三条。 */
export async function downloadMediaCandidates(urls: string[], destination: string, kind: 'image' | 'video', headers: Record<string, string>, signal?: AbortSignal): Promise<string> {
  const deadline = AbortSignal.any([AbortSignal.timeout(kind === 'video' ? 120_000 : 25_000), ...(signal ? [signal] : [])])
  let lastError: unknown = new Error('没有可下载的媒体地址')
  for (const url of [...new Set(urls)].slice(0, 3)) {
    deadline.throwIfAborted()
    try { return await downloadMedia(url, destination, kind, headers, deadline) }
    catch (error) { lastError = error }
  }
  throw lastError
}
