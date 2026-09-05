import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { getModelsDir } from '../dataLocation'
import type { ModelStatus } from '../../shared/ipc'

/* ================================================================
   模型下载器 — HuggingFace（hf-mirror 镜像优先，直连兜底）
   本地文件布局（与 embedder/local.ts 约定一致）:
     models/bge/bge-small-zh-v1.5.onnx   文本语义 (512d)
     models/bge/bge-vocab.txt
     models/clip/clip-vit-b32-image.onnx 图片编码 (512d)
     models/clip/clip-vit-b32-text.onnx  文本对齐编码 (512d)
     models/clip/clip-vocab.json         CLIP 词表
   ================================================================ */

type ProgressCb = (status: ModelStatus) => void

interface RemoteFile {
  repo: string
  remote: string
  local: string
}

const MODELS: Record<string, { files: RemoteFile[]; label: string }> = {
  bge: {
    label: 'BGE-small-zh-v1.5（文本语义检索）',
    files: [
      { repo: 'Xenova/bge-small-zh-v1.5', remote: 'onnx/model.onnx', local: 'bge-small-zh-v1.5.onnx' },
      { repo: 'Xenova/bge-small-zh-v1.5', remote: 'vocab.txt', local: 'bge-vocab.txt' }
    ]
  },
  clip: {
    label: 'CLIP ViT-B/32（图片检索 / 以文搜图，约 150MB）',
    files: [
      { repo: 'Xenova/clip-vit-base-patch32', remote: 'onnx/vision_model_quantized.onnx', local: 'clip-vit-b32-image.onnx' },
      { repo: 'Xenova/clip-vit-base-patch32', remote: 'onnx/text_model_quantized.onnx', local: 'clip-vit-b32-text.onnx' },
      { repo: 'Xenova/clip-vit-base-patch32', remote: 'vocab.json', local: 'clip-vocab.json' },
      { repo: 'Xenova/clip-vit-base-patch32', remote: 'merges.txt', local: 'clip-merges.txt' }
    ]
  }
}

const MIRRORS = ['https://hf-mirror.com', 'https://huggingface.co']

const active = new Map<string, ModelStatus>()

export function modelStatuses(): ModelStatus[] {
  const out: ModelStatus[] = []
  for (const [key, m] of Object.entries(MODELS)) {
    const running = active.get(key)
    if (running) {
      out.push(running)
      continue
    }
    const dir = join(getModelsDir(), key)
    const downloaded = m.files.every((f) => existsSync(join(dir, f.local)) && statSync(join(dir, f.local)).size > 1000)
    out.push({
      name: key,
      downloaded,
      downloading: false,
      progress: downloaded ? 1 : 0,
      totalBytes: 0,
      downloadedBytes: 0
    })
  }
  return out
}

export async function downloadModel(key: string, onProgress?: ProgressCb): Promise<void> {
  const m = MODELS[key]
  if (!m) throw new Error(`未知模型: ${key}`)
  if (active.has(key)) return /* 已在下载 */

  const dir = join(getModelsDir(), key)
  mkdirSync(dir, { recursive: true })

  const totalFiles = m.files.length
  let doneFiles = 0
  const status: ModelStatus = {
    name: key,
    downloaded: false,
    downloading: true,
    progress: 0,
    totalBytes: 0,
    downloadedBytes: 0
  }
  active.set(key, status)

  const emit = (): void => onProgress?.({ ...status })

  try {
    for (const f of m.files) {
      const target = join(dir, f.local)
      if (existsSync(target) && statSync(target).size > 1000) {
        doneFiles++
        status.progress = doneFiles / totalFiles
        emit()
        continue
      }
      await downloadFileWithMirrors(f, target, (downloaded, total) => {
        status.downloadedBytes = downloaded
        status.totalBytes = total
        status.progress = (doneFiles + (total ? downloaded / total : 0)) / totalFiles
        emit()
      })
      doneFiles++
      status.progress = doneFiles / totalFiles
      emit()
    }
    status.downloading = false
    status.downloaded = true
    status.progress = 1
  } catch (err) {
    status.downloading = false
    status.downloaded = false
    active.delete(key)
    throw err
  }
  active.delete(key)
  emit()
}

/* ---- 断点记录：tmp 文件 + 完成后 rename ---- */
async function downloadFileWithMirrors(
  f: RemoteFile,
  target: string,
  onBytes: (downloaded: number, total: number) => void
): Promise<void> {
  let lastErr: unknown = null
  for (const mirror of MIRRORS) {
    const url = `${mirror}/${f.repo}/resolve/main/${f.remote}`
    try {
      await downloadFile(url, target, onBytes)
      return
    } catch (err) {
      lastErr = err
      console.warn(`[models] ${mirror} 下载失败:`, err instanceof Error ? err.message : err)
    }
  }
  throw new Error(`模型文件下载失败（已尝试 ${MIRRORS.length} 个源）: ${f.remote} — ${lastErr instanceof Error ? lastErr.message : lastErr}`)
}

async function downloadFile(
  url: string,
  target: string,
  onBytes: (downloaded: number, total: number) => void
): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

  const total = parseInt(res.headers.get('content-length') ?? '0', 10)
  const tmp = `${target}.tmp`
  let downloaded = 0

  const source = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
  /* 计数 + 进度节流 */
  let lastEmit = 0
  source.on('data', (chunk: Buffer) => {
    downloaded += chunk.length
    const now = Date.now()
    if (now - lastEmit > 300) {
      lastEmit = now
      onBytes(downloaded, total)
    }
  })

  await pipeline(source, createWriteStream(tmp))
  onBytes(downloaded, total || downloaded)
  if (existsSync(target)) unlinkSync(target)
  await rename(tmp, target)
}
