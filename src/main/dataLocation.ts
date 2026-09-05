import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'

/** 获取/创建应用数据根目录 */
export function getDataDir(): string {
  const dir = join(app.getPath('userData'))
  ensureDir(dir)
  return dir
}

/** 数据库文件路径 */
export function getDbPath(): string {
  return join(getDataDir(), 'oasis-documents.db')
}

/** LanceDB 向量库目录 */
export function getVectorDbPath(): string {
  const dir = join(getDataDir(), 'vectors')
  ensureDir(dir)
  return dir
}

/** 媒体文件存储目录（缩略图、缓存等） */
export function getMediaDir(): string {
  const dir = join(getDataDir(), 'media')
  ensureDir(dir)
  return dir
}

/** 模型下载目录 */
export function getModelsDir(): string {
  const dir = join(getDataDir(), 'models')
  ensureDir(dir)
  return dir
}

/** 缩略图缓存目录 */
export function getThumbnailsDir(): string {
  const dir = join(getMediaDir(), 'thumbnails')
  ensureDir(dir)
  return dir
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}
