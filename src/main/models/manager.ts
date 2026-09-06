import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { rename, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { app } from 'electron'
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
     models/clip-zh/cn_clip_vision.onnx  中文 CLIP 图片编码 (512d)
     models/clip-zh/cn_clip_text.onnx    中文 CLIP 文本编码 (512d)
     models/clip-zh/vocab.txt            中文 BERT 词表
   ================================================================ */

type ProgressCb = (status: ModelStatus) => void

interface RemoteFile {
  repo: string
  remote: string
  local: string
}

const MODELS: Record<string, { files: RemoteFile[]; altFiles?: string[]; bundled?: boolean; label: string }> = {
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
  },
  /* 中文 CLIP(以文搜图主力):优先安装内置 int8 量化版(约 190MB,
     实测与 fp32 输出余弦 ≥0.97);内置缺失时网络兜底下载 fp32(约 750MB)。
     三件套齐备时 embedder 自动优先启用,图片向量空间随之切换并全量重嵌 */
  'clip-zh': {
    label: '中文 CLIP ViT-B/16 int8（中文以文搜图/以图搜图，约 190MB，推荐）',
    bundled: true,
    altFiles: ['cn_clip_vision.int8.onnx', 'cn_clip_text.int8.onnx', 'vocab.txt'],
    files: [
      { repo: 'felixdu/chinese-clip-vit-base-patch16-onnx', remote: 'cn_clip_vision.onnx', local: 'cn_clip_vision.onnx' },
      { repo: 'felixdu/chinese-clip-vit-base-patch16-onnx', remote: 'cn_clip_text.onnx', local: 'cn_clip_text.onnx' },
      { repo: 'OFA-Sys/chinese-clip-vit-base-patch16', remote: 'vocab.txt', local: 'vocab.txt' }
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
    /* 内置 int8 变体或网络下载的完整文件集,任一齐备即视为已安装 */
    const altOk = m.altFiles
      ? m.altFiles.every((f) => existsSync(join(dir, f)) && statSync(join(dir, f)).size > 1000)
      : false
    const downloaded =
      altOk || m.files.every((f) => existsSync(join(dir, f.local)) && statSync(join(dir, f.local)).size > 1000)
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
    /* 内置模型优先:resources/models 里的 int8 量化版直接复制,免下载秒装 */
    if (m.bundled && m.altFiles) {
      status.progress = 0.5
      emit()
      if (await copyBundledModels(key, m.altFiles)) {
        status.downloading = false
        status.downloaded = true
        status.progress = 1
        active.delete(key)
        emit()
        return
      }
      /* 内置缺失(如克隆仓库未带 models 目录):降级走网络下载 fp32 */
      console.warn(`[models] ${key} 无内置文件,走网络下载兜底`)
      status.progress = 0
      emit()
    }
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

/* ---- 内置模型:resources/models → 用户数据目录 ---- */

/** 内置模型源目录:dev = <项目根>/resources/models;
    打包后 = <Contents>/Resources/models(electron-builder extraResources) */
function bundledModelsDir(key: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'models', key)
    : join(app.getAppPath(), 'resources', 'models', key)
}

async function copyBundledModels(key: string, altFiles: string[]): Promise<boolean> {
  const src = bundledModelsDir(key)
  if (!altFiles.every((f) => existsSync(join(src, f)) && statSync(join(src, f)).size > 1000)) return false
  const dir = join(getModelsDir(), key)
  mkdirSync(dir, { recursive: true })
  for (const f of altFiles) await copyFile(join(src, f), join(dir, f))
  return true
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
