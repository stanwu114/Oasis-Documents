import { getDb } from '../db'
import { hydrateEmbeddingSettings } from '../credentials'
import { LocalTextEmbedder, LocalImageEmbedder } from './local'
import { RemoteTextEmbedder, fromSettings } from './remote'
import type { TextEmbedder, ImageEmbedder } from './types'
import type { EmbeddingSettings } from '../../shared/ipc'

/* ================================================================
   嵌入引擎调度：
   - 文本：按设置选 本地 BGE 或 在线 API（在线失败自动降级本地）
   - 图片：永远本地 CLIP（在线 API 不支持图片）
   ================================================================ */

let cached: {
  settings: EmbeddingSettings
  text: TextEmbedder
  textFallback: TextEmbedder | null
  image: ImageEmbedder
} | null = null

export function getEmbedders(): { text: TextEmbedder; image: ImageEmbedder } {
  const e = ensure()
  return { text: e.text, image: e.image }
}

/** 稳健版：在线失败时降级到本地 BGE */
export async function embedTextsSafe(texts: string[]): Promise<{ vectors: number[][]; usedProvider: string }> {
  const e = ensure()
  try {
    const vectors = await e.text.embedTexts(texts)
    return { vectors, usedProvider: e.text.info.name }
  } catch (err) {
    if (e.textFallback && e.textFallback !== e.text) {
      console.warn('[embedder] 在线嵌入失败，降级本地:', err instanceof Error ? err.message : err)
      const vectors = await e.textFallback.embedTexts(texts)
      return { vectors, usedProvider: `${e.textFallback.info.name} (fallback)` }
    }
    throw err
  }
}

/* BGE 官方检索协议：查询侧加指令前缀、文档侧不加（v1.5 中文检索标准用法）。
   不加指令时查询与文档的表示分布有偏，召回质量明显下降 */
const BGE_QUERY_INSTRUCTION = '为这个句子生成表示以用于检索相关文章:'

/** 检索查询专用嵌入：本地 BGE 自动附加查询指令；在线 API 不加（各家协议不同） */
export async function embedQuerySafe(query: string): Promise<{ vectors: number[][]; usedProvider: string }> {
  const e = ensure()
  const withInstruction = (emb: TextEmbedder): string[] => [
    emb instanceof LocalTextEmbedder ? `${BGE_QUERY_INSTRUCTION}${query}` : query
  ]
  try {
    const vectors = await e.text.embedTexts(withInstruction(e.text))
    return { vectors, usedProvider: e.text.info.name }
  } catch (err) {
    if (e.textFallback && e.textFallback !== e.text) {
      console.warn('[embedder] 在线查询嵌入失败，降级本地:', err instanceof Error ? err.message : err)
      const vectors = await e.textFallback.embedTexts(withInstruction(e.textFallback))
      return { vectors, usedProvider: `${e.textFallback.info.name} (fallback)` }
    }
    throw err
  }
}

export function embedImages(imagePaths: string[]): Promise<number[][]> {
  return ensure().image.embedImages(imagePaths)
}

export function embedTextToImageSpace(text: string): Promise<number[]> {
  return ensure().image.embedTextToImageSpace(text)
}

/** 当前图片向量空间身份(中英 CLIP 同为 512 维但空间不兼容,
    LanceDB 写入前据此校验,切换时 drop 重建并全量重嵌) */
export function activeImageVectorSpace(): string {
  const img = ensure().image
  return img instanceof LocalImageEmbedder ? img.space : 'image-space-unknown'
}

export function invalidateEmbedderCache(): void {
  cached = null
}

/** 就绪状态：模型没下载/在线没配置时，嵌入管线据此跳过并标记待补。
 *  R11：以构造类型判断在线/本地——旧实现用 `as` 断言兜底，
 *  在线模式 + 本地 BGE 未下载时被误判为不可用 */
export function embedderReadiness(): { textReady: boolean; imageReady: boolean } {
  const e = ensure()
  const online = e.text instanceof RemoteTextEmbedder
  const local = online ? e.textFallback : (e.text as LocalTextEmbedder | null)
  return {
    textReady: online || (local instanceof LocalTextEmbedder ? local.isReady : false),
    imageReady: e.image instanceof LocalImageEmbedder ? e.image.isReady : false
  }
}

/** 读取嵌入配置(含凭据还原);状态页等外部模块共用 */
export function loadEmbeddingSettings(): EmbeddingSettings {
  return loadSettings()
}

function loadSettings(): EmbeddingSettings {
  const db = getDb()
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'embedding'`).get() as { value: string } | undefined
  if (!row) return defaultSettings()
  /* R26：配置中的 Key 是凭据引用，经还原获得真实值 */
  return hydrateEmbeddingSettings(JSON.parse(row.value) as EmbeddingSettings)
}

function ensure() {
  if (cached) return cached
  const settings = loadSettings()

  const localText = new LocalTextEmbedder(settings.local)
  const image = new LocalImageEmbedder(settings.local)

  const remote = fromSettings(settings)
  let text: TextEmbedder = localText
  let textFallback: TextEmbedder | null = null
  if (remote) {
    text = remote
    textFallback = localText.isReady ? localText : null
    if (settings.advanced?.onlineConcurrency) remote.setConcurrency(settings.advanced.onlineConcurrency)
    if (settings.advanced?.timeoutMs) remote.setTimeoutMs(settings.advanced.timeoutMs)
  }

  cached = { settings, text, textFallback, image }
  return cached
}

function defaultSettings(): EmbeddingSettings {
  return {
    defaultProvider: 'local',
    local: { clipModelPath: '', bgeModelPath: '' },
    providers: {
      openai: { enabled: false, apiKey: '', model: 'text-embedding-3-small' },
      zhipu: { enabled: false, apiKey: '', model: 'embedding-3' },
      qwen: { enabled: false, apiKey: '', model: 'text-embedding-v3' },
      custom: { enabled: false, apiKey: '', model: '', baseUrl: '', dimensions: 0 }
    },
    onlineLlm: { enabled: false, provider: 'zhipu', apiKey: '', model: 'glm-4-flash' },
    onlineMultimodal: { enabled: false, provider: 'qwen', apiKey: '', model: 'qwen-vl-plus' },
    advanced: {
      autoReindexOnModelChange: false,
      imageSearchStrategy: 'clip-only',
      batchSize: 32,
      onlineConcurrency: 5,
      timeoutMs: 30000
    }
  }
}
