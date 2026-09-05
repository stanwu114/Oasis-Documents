import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { getMediaDir } from './dataLocation'

/* ================================================================
   图片解码桥接：HEIC/HEIF（iPhone 照片，HEVC 编码）sharp 预编译版
   缺解码插件，用 macOS 系统自带 sips 转 JPEG（缓存复用）
   ================================================================ */

const HEIC_RE = /\.hei[cf]$/i

let cacheDir: string | null = null

function getCacheDir(): string {
  if (!cacheDir) {
    cacheDir = join(getMediaDir(), 'heic-cache')
    mkdirSync(cacheDir, { recursive: true })
  }
  return cacheDir
}

/**
 * 返回 sharp 可处理的图片路径：HEIC/HEIF 先经 sips 转 JPEG（带缓存），
 * 其他格式原样返回。非 macOS 平台无 sips，原样返回走 sharp 自身降级。
 */
export async function ensureDecodableImage(path: string): Promise<string> {
  if (!HEIC_RE.test(path)) return path
  if (process.platform !== 'darwin') return path

  const key = createHash('sha1').update(path).digest('hex').slice(0, 16)
  const out = join(getCacheDir(), `${key}.jpg`)
  if (existsSync(out) && statSync(out).size > 1000) return out

  await new Promise<void>((resolve, reject) => {
    execFile(
      'sips',
      ['-s', 'format', 'jpeg', '-s', 'formatOptions', '90', path, '--out', out],
      { timeout: 30_000 },
      (err) => (err ? reject(err) : resolve())
    )
  })
  return out
}
