/* ================================================================
   嵌入引擎统一接口 — 本地 ONNX 与在线 API 实现同一契约
   ================================================================ */

export type EmbedProvider = 'local' | 'openai' | 'zhipu' | 'qwen' | 'custom'

export interface EmbedderModelInfo {
  name: string
  dimensions: number
  supportsImages: boolean
  supportsBatch: boolean
}

export interface TextEmbedder {
  readonly info: EmbedderModelInfo
  embedTexts(texts: string[]): Promise<number[][]>
}

export interface ImageEmbedder {
  readonly info: EmbedderModelInfo
  embedImages(imagePaths: string[]): Promise<number[][]>
  /** CLIP 文本编码器：把查询文本嵌入到与图片相同的向量空间（以文搜图用） */
  embedTextToImageSpace(text: string): Promise<number[]>
}

export class EmbedderError extends Error {
  constructor(
    message: string,
    public readonly provider: EmbedProvider,
    public readonly fallbackAvailable = false
  ) {
    super(message)
  }
}
