import * as ort from 'onnxruntime-node'
import sharp from 'sharp'
import { readFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { getModelsDir } from '../dataLocation'
import type { EmbedderModelInfo, ImageEmbedder, TextEmbedder } from './types'
import type { EmbeddingSettings } from '../../shared/ipc'

/* ONNX 会话线程数：外层嵌入并发 6 × 会话内 4 线程 ≈ CPU 核数，避免超售 */
const ORT_OPTS = (): ort.InferenceSession.SessionOptions => ({
  executionProviders: ['cpu'],
  intraOpNumThreads: Math.max(2, Math.min(4, Math.floor(cpus().length / 2)))
})

/* 同一 InferenceSession 的 run 必须串行（onnxruntime-node 并发 run 同一
   session 会死锁挂起，任务永不返回）；不同 session 之间仍并行 */
class RunMutex {
  private chain: Promise<unknown> = Promise.resolve()
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(task, task)
    this.chain = result.catch(() => undefined)
    return result
  }
}

/* ================================================================
   本地 ONNX 嵌入（权重来自 Xenova/transformers.js 生态的 ONNX 导出）：
   - BGE-small-zh-v1.5  → 文本语义（以文搜文），输出 hidden states 需 mean pooling
   - CLIP ViT-B/32 (int8) → 图片向量 + 文本对齐（以图搜图 / 以文搜图）
   ================================================================ */

/* ---- BGE tokenizer：WordPiece（bert 系） ---- */
class BgeTokenizer {
  private vocab = new Map<string, number>()
  private maxId = 0
  constructor(vocabPath: string) {
    const lines = readFileSync(vocabPath, 'utf8').split('\n')
    lines.forEach((line, i) => {
      const tok = line.trim()
      if (!tok) return /* 文件末尾空行不是 token，防止越界 ID */
      this.vocab.set(tok, i)
      this.maxId = Math.max(this.maxId, i)
    })
  }
  /** 词表查找 + 越界钳制（词表外一律 [UNK]，绝不产生非法索引） */
  private id(token: string): number {
    const v = this.vocab.get(token) ?? this.vocab.get('[UNK]') ?? 100
    return Math.max(0, Math.min(v, this.maxId))
  }
  encode(text: string, maxLen = 512): { inputIds: BigInt64Array; attentionMask: BigInt64Array; tokenTypeIds: BigInt64Array } {
    const cls = this.id('[CLS]')
    const sep = this.id('[SEP]')
    const ids: number[] = [cls]
    for (const w of text.toLowerCase().replace(/\s+/g, ' ').trim().split(' ')) {
      if (!w) continue /* 连续空格产生的空 token 跳过 */
      if (this.vocab.has(w)) {
        ids.push(this.id(w))
      } else {
        /* 未登录词按字符切（中文主流场景） */
        for (const ch of w) {
          if (ch) ids.push(this.id(ch))
        }
      }
      if (ids.length >= maxLen - 1) break
    }
    ids.push(sep)
    return {
      inputIds: new BigInt64Array(ids.map((i) => BigInt(i))),
      attentionMask: new BigInt64Array(new Array(ids.length).fill(1n)),
      tokenTypeIds: new BigInt64Array(new Array(ids.length).fill(0n))
    }
  }
}

/* ---- CLIP tokenizer：官方 byte-level BPE（R13 完整实现）
   对照 openai/CLIP simple_tokenizer.py：byte↔unicode 映射、预分词正则、
   merges 合并、vocab 编码、77 token 截断（SOT=49406 … EOT … pad=0） ---- */
class ClipTokenizer {
  private vocab = new Map<string, number>()
  private ranks = new Map<string, number>() /* "a b" 对 → 合并优先级 */
  private byteEncoder!: Map<number, string>
  private cache = new Map<string, string[]>()

  constructor(vocabPath: string, mergesPath: string) {
    const raw = JSON.parse(readFileSync(vocabPath, 'utf8')) as Record<string, number>
    for (const [k, v] of Object.entries(raw)) this.vocab.set(k, v)
    const merges = readFileSync(mergesPath, 'utf8').split('\n')
    let rank = 0
    for (const line of merges) {
      const t = line.trim()
      if (t && !t.startsWith('#')) this.ranks.set(t, rank++)
    }
    this.byteEncoder = buildByteEncoder()
  }

  encode(text: string, maxLen = 77): BigInt64Array {
    const sot = this.vocab.get('<|startoftext|>') ?? 49406
    const eot = this.vocab.get('<|endoftext|>') ?? 49407
    const out = new BigInt64Array(maxLen).fill(0n)
    out[0] = BigInt(sot)

    const words = text
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()
      .match(/<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|\p{N}|[^\s\p{L}\p{N}]+/gu) ?? []

    let pos = 1
    outer: for (const word of words) {
      const tokens = this.bpe(word)
      for (const t of tokens) {
        if (pos >= maxLen - 1) break outer
        out[pos] = BigInt(this.vocab.get(t) ?? eot)
        pos++
      }
    }
    out[pos] = BigInt(eot)
    return out
  }

  /** 词 → byte-level 字符序列 → 按 ranks 迭代合并最低优先级对 */
  private bpe(word: string): string[] {
    const cached = this.cache.get(word)
    if (cached) return cached

    /* 词 → UTF-8 字节 → byte_encoder 映射为 unicode 字符 */
    const chars: string[] = []
    for (const b of Buffer.from(word, 'utf8')) chars.push(this.byteEncoder.get(b) as string)

    let parts = chars
    while (parts.length > 1) {
      let bestRank = Infinity
      let bestIdx = -1
      for (let i = 0; i < parts.length - 1; i++) {
        const r = this.ranks.get(`${parts[i]} ${parts[i + 1]}`) ?? Infinity
        if (r < bestRank) {
          bestRank = r
          bestIdx = i
        }
      }
      if (bestIdx < 0) break /* 无可合并对 */
      parts = [
        ...parts.slice(0, bestIdx),
        parts[bestIdx] + parts[bestIdx + 1],
        ...parts.slice(bestIdx + 2)
      ]
    }
    if (this.cache.size > 10_000) this.cache.clear() /* 简单防膨胀 */
    this.cache.set(word, parts)
    return parts
  }
}

/** 官方 bytes_to_unicode：可打印字节原样，其余映射到 256+n 区段 */
function buildByteEncoder(): Map<number, string> {
  const bs: number[] = []
  for (let b = 33; b <= 126; b++) bs.push(b)
  for (let b = 161; b <= 172; b++) bs.push(b)
  for (let b = 174; b <= 255; b++) bs.push(b)
  const cs = [...bs]
  let n = 0
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b)
      cs.push(256 + n)
      n++
    }
  }
  const m = new Map<number, string>()
  bs.forEach((b, i) => m.set(b, String.fromCharCode(cs[i])))
  return m
}

/* ================================================================ */

export class LocalTextEmbedder implements TextEmbedder {
  private session: ort.InferenceSession | null = null
  private tokenizer: BgeTokenizer | null = null
  private mutex = new RunMutex()
  /* R28：初始化单飞——并发冷启动只触发一次模型加载 */
  private initPromise: Promise<void> | null = null
  readonly info: EmbedderModelInfo

  constructor(private settings: EmbeddingSettings['local']) {
    this.info = { name: 'bge-small-zh-v1.5', dimensions: 512, supportsImages: false, supportsBatch: true }
  }

  get isReady(): boolean {
    return existsSync(this.modelPath('bge-small-zh-v1.5.onnx')) && existsSync(this.modelPath('bge-vocab.txt'))
  }

  private modelPath(name: string): string {
    return this.settings.bgeModelPath || `${getModelsDir()}/bge/${name}`
  }

  private ensureSession(): Promise<void> {
    if (this.session) return Promise.resolve()
    if (!this.initPromise) {
      this.initPromise = (async () => {
        if (!this.isReady) throw new Error('BGE 模型未下载（设置 → 模型管理）')
        const buf = await readFile(this.modelPath('bge-small-zh-v1.5.onnx'))
        this.session = await ort.InferenceSession.create(buf, ORT_OPTS())
        this.tokenizer = new BgeTokenizer(this.modelPath('bge-vocab.txt'))
      })().catch((e) => {
        this.initPromise = null /* 失败允许重试 */
        throw e
      })
    }
    return this.initPromise
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    await this.ensureSession()
    const out: number[][] = []
    for (const text of texts) {
      const tok = this.tokenizer!.encode(text)
      const feeds: Record<string, ort.Tensor> = {
        input_ids: new ort.Tensor('int64', tok.inputIds, [1, tok.inputIds.length]),
        attention_mask: new ort.Tensor('int64', tok.attentionMask, [1, tok.attentionMask.length]),
        token_type_ids: new ort.Tensor('int64', tok.tokenTypeIds, [1, tok.tokenTypeIds.length])
      }
      const tensor = await this.mutex.run(async () => {
        const res = await this.session!.run(feeds)
        /* 按名称选择输出，不依赖 Object.values 顺序（R13） */
        return res.logits ?? res.last_hidden_state ?? Object.values(res)[0]
      })
      out.push(poolToVector(tensor, 'cls'))
    }
    return out
  }
}

export class LocalImageEmbedder implements ImageEmbedder {
  private imgSession: ort.InferenceSession | null = null
  private txtSession: ort.InferenceSession | null = null
  private clipTokenizer: ClipTokenizer | null = null
  private imgMutex = new RunMutex()
  private txtMutex = new RunMutex()
  readonly info: EmbedderModelInfo

  constructor(private settings: EmbeddingSettings['local']) {
    this.info = { name: 'clip-vit-b32', dimensions: 512, supportsImages: true, supportsBatch: true }
  }

  get isReady(): boolean {
    return (
      existsSync(this.clipPath('clip-vit-b32-image.onnx')) &&
      existsSync(this.clipPath('clip-vit-b32-text.onnx')) &&
      existsSync(this.clipPath('clip-vocab.json')) &&
      existsSync(this.clipPath('clip-merges.txt'))
    )
  }

  private clipPath(name: string): string {
    return this.settings.clipModelPath || `${getModelsDir()}/clip/${name}`
  }

  private initPromise: Promise<void> | null = null

  private ensureSessions(): Promise<void> {
    if (this.imgSession && this.txtSession) return Promise.resolve()
    if (!this.initPromise) {
      this.initPromise = (async () => {
        if (!this.isReady) throw new Error('CLIP 模型未下载（设置 → 模型管理）')
        const [imgBuf, txtBuf] = await Promise.all([
          readFile(this.clipPath('clip-vit-b32-image.onnx')),
          readFile(this.clipPath('clip-vit-b32-text.onnx'))
        ])
        ;[this.imgSession, this.txtSession] = await Promise.all([
          ort.InferenceSession.create(imgBuf, ORT_OPTS()),
          ort.InferenceSession.create(txtBuf, ORT_OPTS())
        ])
        this.clipTokenizer = new ClipTokenizer(this.clipPath('clip-vocab.json'), this.clipPath('clip-merges.txt'))
      })().catch((e) => {
        this.initPromise = null
        throw e
      })
    }
    return this.initPromise
  }

  /** 图片 → 224x224 RGB，CLIP 均值方差归一化（HEIC 先经 sips 桥接） */
  private async preprocess(path: string): Promise<Float32Array> {
    const { ensureDecodableImage } = await import('../image-decode')
    const decodable = await ensureDecodableImage(path)
    const { data } = await sharp(decodable, { failOn: 'none' })
      .removeAlpha()
      .resize(224, 224, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true })
    const mean = [0.48145466, 0.4578275, 0.40821073]
    const std = [0.26862954, 0.26130258, 0.27577711]
    const out = new Float32Array(3 * 224 * 224)
    for (let i = 0; i < 224 * 224; i++) {
      for (let c = 0; c < 3; c++) {
        out[c * 224 * 224 + i] = (data[i * 3 + c] / 255 - mean[c]) / std[c]
      }
    }
    return out
  }

  async embedImages(imagePaths: string[]): Promise<number[][]> {
    await this.ensureSessions()
    const out: number[][] = []
    for (const p of imagePaths) {
      const pixel = await this.preprocess(p)
      const tensor = await this.imgMutex.run(async () => {
        const res = await this.imgSession!.run({
          pixel_values: new ort.Tensor('float32', pixel, [1, 3, 224, 224])
        })
        return Object.values(res)[0]
      })
      out.push(poolToVector(tensor))
    }
    return out
  }

  async embedTextToImageSpace(text: string): Promise<number[]> {
    await this.ensureSessions()
    const tokens = this.clipTokenizer!.encode(text)
    const tensor = await this.txtMutex.run(async () => {
      const res = await this.txtSession!.run({
        input_ids: new ort.Tensor('int64', tokens, [1, tokens.length])
      })
      return Object.values(res)[0]
    })
    return poolToVector(tensor)
  }
}

/**
 * ONNX 输出 → 句/图向量（R13：池化方式按模型协议选择）：
 * [1, dim]       直接归一化返回（CLIP embeds）
 * [1, seq, dim]  'cls' → 首 token（CLS）池化（BGE 官方协议）
 *                'mean' → 平均池化（其他 BERT 系兜底）
 */
function poolToVector(tensor: ort.Tensor, mode: 'cls' | 'mean' = 'mean'): number[] {
  const data = tensor.data as Float32Array
  const dims = tensor.dims
  if (dims.length === 2 && dims[0] === 1) {
    return normalize(Array.from(data))
  }
  if (dims.length === 3 && dims[0] === 1) {
    const [, seq, dim] = dims
    if (mode === 'cls') {
      /* BGE 官方：取 [CLS] 位置的 hidden state */
      return normalize(Array.from(data.slice(0, dim)))
    }
    const pooled = new Array<number>(dim).fill(0)
    for (let s = 0; s < seq; s++) {
      for (let d = 0; d < dim; d++) pooled[d] += data[s * dim + d]
    }
    return normalize(pooled.map((v) => v / seq))
  }
  /* 兜底：整体当一维向量 */
  return normalize(Array.from(data))
}

function normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1
  return vec.map((v) => v / norm)
}
