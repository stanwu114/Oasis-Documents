import type { EmbedderModelInfo, TextEmbedder } from './types'
import type { EmbeddingSettings } from '../../shared/ipc'

/* ================================================================
   在线嵌入 API — OpenAI 兼容协议（OpenAI / 智谱 / 通义 / 自定义）
   分批 + 并发闸门 + 指数退避重试
   ================================================================ */

const PROVIDER_DEFAULTS: Record<string, { baseUrl: string; model: string; dimensions: number; batchLimit: number }> = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small', dimensions: 1536, batchLimit: 100 },
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'embedding-3', dimensions: 2048, batchLimit: 32 },
  qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'text-embedding-v3', dimensions: 1024, batchLimit: 25 },
  custom: { baseUrl: '', model: '', dimensions: 0, batchLimit: 32 }
}

export class RemoteTextEmbedder implements TextEmbedder {
  readonly info: EmbedderModelInfo
  private concurrency: number
  private timeoutMs: number

  constructor(
    provider: 'openai' | 'zhipu' | 'qwen' | 'custom',
    apiKey: string,
    model: string,
    baseUrlOverride?: string
  ) {
    const d = PROVIDER_DEFAULTS[provider]
    this.provider = provider
    this.apiKey = apiKey
    this.model = model
    this.baseUrl = baseUrlOverride || d.baseUrl
    this.info = { name: `${provider}:${model}`, dimensions: d.dimensions, supportsImages: false, supportsBatch: true }
    this.concurrency = 5
    this.timeoutMs = 30000
  }

  private readonly provider: 'openai' | 'zhipu' | 'qwen' | 'custom'
  private readonly apiKey: string
  private readonly model: string
  private baseUrl: string

  setConcurrency(n: number): void {
    this.concurrency = Math.max(1, Math.min(20, n))
  }
  setTimeoutMs(ms: number): void {
    this.timeoutMs = ms
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    const batchLimit = PROVIDER_DEFAULTS[this.provider].batchLimit
    const batches: string[][] = []
    for (let i = 0; i < texts.length; i += batchLimit) batches.push(texts.slice(i, i + batchLimit))

    const results: number[][][] = new Array(batches.length)
    let cursor = 0

    const worker = async (): Promise<void> => {
      while (cursor < batches.length) {
        const idx = cursor++
        results[idx] = await this.embedBatchWithRetry(batches[idx])
      }
    }
    await Promise.all(Array.from({ length: Math.min(this.concurrency, batches.length) }, worker))

    /* 保持与输入顺序一致 */
    return results.flat()
  }

  private async embedBatchWithRetry(batch: string[], maxRetries = 3): Promise<number[][]> {
    let lastErr: Error | null = null
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.embedBatch(batch)
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err))
        const retryable = isRetryable(lastErr)
        if (!retryable) throw lastErr
        await sleep(Math.min(2000 * 2 ** attempt, 30000))
      }
    }
    throw lastErr ?? new Error('嵌入请求失败')
  }

  private async embedBatch(batch: string[]): Promise<number[][]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({ model: this.model, input: batch.map((t) => t.slice(0, 8000)) })
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`API ${res.status}: ${body.slice(0, 200)}`)
      }
      const json = (await res.json()) as { data: { embedding: number[]; index: number }[] }
      /* 按 index 归位（服务端不保证顺序） */
      const out = new Array<number[]>(batch.length)
      for (const d of json.data) out[d.index] = d.embedding
      return out
    } finally {
      clearTimeout(timer)
    }
  }
}

function isRetryable(err: Error): boolean {
  return /429|5\d\d|network|fetch failed|abort/i.test(err.message)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 从设置构建在线 embedder；provider 未启用时返回 null */
export function fromSettings(settings: EmbeddingSettings): RemoteTextEmbedder | null {
  const p = settings.defaultProvider
  if (p === 'local') return null
  const conf = settings.providers[p]
  if (!conf?.enabled || !conf.apiKey) return null
  return new RemoteTextEmbedder(p, conf.apiKey, conf.model, 'baseUrl' in conf ? conf.baseUrl : undefined)
}
