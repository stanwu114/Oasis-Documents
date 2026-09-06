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
    /* N03：批推理——同批 padding 到最长序列，一次 run [B, L]；
         吞吐量为逐条的数倍（外层调用一次只传 1 条时自动退化为 batch=1） */
    const out: number[][] = []
    const BATCH = 16
    for (let b = 0; b < texts.length; b += BATCH) {
      const batchTexts = texts.slice(b, b + BATCH)
      const toks = batchTexts.map((t) => this.tokenizer!.encode(t))
      const L = Math.max(...toks.map((t) => t.inputIds.length))
      const B = toks.length
      const ids = new BigInt64Array(B * L)
      const mask = new BigInt64Array(B * L)
      const typeIds = new BigInt64Array(B * L)
      for (let i = 0; i < B; i++) {
        for (let j = 0; j < toks[i].inputIds.length; j++) {
          ids[i * L + j] = toks[i].inputIds[j]
          mask[i * L + j] = toks[i].attentionMask[j]
          typeIds[i * L + j] = toks[i].tokenTypeIds[j]
        }
      }
      const tensor = await this.mutex.run(async () => {
        const res = await this.session!.run({
          input_ids: new ort.Tensor('int64', ids, [B, L]),
          attention_mask: new ort.Tensor('int64', mask, [B, L]),
          token_type_ids: new ort.Tensor('int64', typeIds, [B, L])
        })
        return res.logits ?? res.last_hidden_state ?? Object.values(res)[0]
      })
      /* [B, L, dim] → 逐条取 CLS（首个有效 token，padding 已由 mask 界定） */
      const dims = tensor.dims
      if (dims.length === 3 && dims[0] === B) {
        const data = tensor.data as Float32Array
        const dim = dims[2]
        for (let i = 0; i < B; i++) {
          out.push(poolToVector({ data: data.subarray(i * L * dim, (i + 1) * L * dim), dims: [1, L, dim], type: tensor.type } as unknown as ort.Tensor, 'cls'))
        }
      } else if (dims.length === 2 && dims[0] === B) {
        const data = tensor.data as Float32Array
        const dim = dims[1]
        for (let i = 0; i < B; i++) {
          out.push(poolToVector({ data: data.subarray(i * dim, (i + 1) * dim), dims: [1, dim], type: tensor.type } as unknown as ort.Tensor, 'cls'))
        }
      } else {
        throw new Error(`BGE 批输出形状异常: [${dims.join(',')}]`)
      }
    }
    return out
  }
}

export class LocalImageEmbedder implements ImageEmbedder {
  private imgSession: ort.InferenceSession | null = null
  private txtSession: ort.InferenceSession | null = null
  private clipTokenizer: ClipTokenizer | null = null
  /* 中文 CLIP 文本塔是 BERT 系(WordPiece + vocab.txt),复用 BGE 同款分词器 */
  private zhTokenizer: BgeTokenizer | null = null
  private imgMutex = new RunMutex()
  private txtMutex = new RunMutex()
  readonly info: EmbedderModelInfo
  /** 当前激活的向量空间身份——中英 CLIP 同为 512 维但语义空间不兼容,
      向量写入前必须以此校验(lancedb.ensureVectorSpace),防跨空间混写 */
  readonly space: string

  constructor(private settings: EmbeddingSettings['local']) {
    const zh = this.zhReady()
    this.space = zh ? 'chinese-clip-vit-b16-zh' : 'clip-vit-b32-en'
    this.info = { name: zh ? 'chinese-clip-vit-b16' : 'clip-vit-b32', dimensions: 512, supportsImages: true, supportsBatch: true }
  }

  get isReady(): boolean {
    return (
      this.zhReady() ||
      (existsSync(this.clipPath('clip-vit-b32-image.onnx')) &&
        existsSync(this.clipPath('clip-vit-b32-text.onnx')) &&
        existsSync(this.clipPath('clip-vocab.json')) &&
        existsSync(this.clipPath('clip-merges.txt')))
    )
  }

  /** 中文 CLIP 就绪(内置 int8 或网络 fp32,任一齐备)——
      中文跨模态检索质量远高于英文 CLIP */
  private zhReady(): boolean {
    return this.zhInt8Ready() || this.zhFp32Ready()
  }

  private zhInt8Ready(): boolean {
    return (
      existsSync(this.zhPath('cn_clip_vision.int8.onnx')) &&
      existsSync(this.zhPath('cn_clip_text.int8.onnx')) &&
      existsSync(this.zhPath('vocab.txt'))
    )
  }

  private zhFp32Ready(): boolean {
    return (
      existsSync(this.zhPath('cn_clip_vision.onnx')) &&
      existsSync(this.zhPath('cn_clip_text.onnx')) &&
      existsSync(this.zhPath('vocab.txt'))
    )
  }

  private zhPath(name: string): string {
    return `${getModelsDir()}/clip-zh/${name}`
  }

  private clipPath(name: string): string {
    return this.settings.clipModelPath || `${getModelsDir()}/clip/${name}`
  }

  private initPromise: Promise<void> | null = null

  private ensureSessions(): Promise<void> {
    if (this.imgSession && this.txtSession) return Promise.resolve()
    if (!this.initPromise) {
      this.initPromise = (async () => {
        if (this.zhReady()) {
          /* 中文 CLIP ViT-B/16:优先 int8 量化版(约 190MB,实测输出与 fp32
             余弦 ≥0.97),否则 fp32(约 720MB)。直接传文件路径加载,
             避免整文件读入内存造成数倍峰值 */
          const vision = this.zhInt8Ready() ? this.zhPath('cn_clip_vision.int8.onnx') : this.zhPath('cn_clip_vision.onnx')
          const text = this.zhInt8Ready() ? this.zhPath('cn_clip_text.int8.onnx') : this.zhPath('cn_clip_text.onnx')
          ;[this.imgSession, this.txtSession] = await Promise.all([
            ort.InferenceSession.create(vision, ORT_OPTS()),
            ort.InferenceSession.create(text, ORT_OPTS())
          ])
          this.zhTokenizer = new BgeTokenizer(this.zhPath('vocab.txt'))
          return
        }
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
    /* N03：图片批推理——预处理（sharp 解码）与推理重叠，≤8 张一批 */
    const out: number[][] = []
    const BATCH = 8
    for (let b = 0; b < imagePaths.length; b += BATCH) {
      const batch = imagePaths.slice(b, b + BATCH)
      const pixels = await Promise.all(batch.map((p) => this.preprocess(p)))
      const B = pixels.length
      const merged = new Float32Array(B * 3 * 224 * 224)
      pixels.forEach((px, i) => merged.set(px, i * px.length))
      const tensor = await this.imgMutex.run(async () => {
        /* 按 session 实际输入名喂给(兼容不同导出约定) */
        const feeds = buildFeeds(this.imgSession!, {
          pixel_values: new ort.Tensor('float32', merged, [B, 3, 224, 224])
        })
        const res = await this.imgSession!.run(feeds)
        return Object.values(res)[0]
      })
      const dims = tensor.dims
      const data = tensor.data as Float32Array
      if (dims.length === 2 && dims[0] === B) {
        const dim = dims[1]
        for (let i = 0; i < B; i++) {
          out.push(poolToVector({ data: data.subarray(i * dim, (i + 1) * dim), dims: [1, dim], type: tensor.type } as unknown as ort.Tensor, 'mean'))
        }
      } else {
        throw new Error(`CLIP 批输出形状异常: [${dims.join(',')}]`)
      }
    }
    return out
  }

  async embedTextToImageSpace(text: string): Promise<number[]> {
    await this.ensureSessions()
    if (this.zhTokenizer) {
      /* 中文 CLIP 文本塔(BERT 系):图为定长 52 静态输入——
         CLS + 50 token + SEP,不足补 [PAD]=0 且 attention_mask 同步置 0。
         分词为词表整词 + 逐字回退,中文汉字基本全覆盖;
         输入名按 session 实际声明匹配(不同导出工具命名有差异) */
      const L = 52
      const tok = this.zhTokenizer.encode(text, L)
      const ids = new BigInt64Array(L) /* 默认 0n = [PAD] */
      const mask = new BigInt64Array(L)
      for (let i = 0; i < tok.inputIds.length && i < L; i++) {
        ids[i] = tok.inputIds[i]
        mask[i] = 1n
      }
      const tensor = await this.txtMutex.run(async () => {
        const feeds = buildFeeds(
          this.txtSession!,
          {
            input_ids: new ort.Tensor('int64', ids, [1, L]),
            attention_mask: new ort.Tensor('int64', mask, [1, L]),
            token_type_ids: new ort.Tensor('int64', new BigInt64Array(L), [1, L])
          },
          this.txtSession!.inputNames
        )
        const res = await this.txtSession!.run(feeds)
        return Object.values(res)[0]
      })
      return poolToVector(tensor)
    }
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

/** 按 session 实际声明的输入名构造 feeds——不同导出工具的输入命名
    可能有差异;缺项直接明确报错,不静默喂错张量 */
function buildFeeds(
  session: ort.InferenceSession,
  candidates: Record<string, ort.Tensor>,
  inputNames?: readonly string[]
): Record<string, ort.Tensor> {
  const names = inputNames ?? session.inputNames
  const feeds: Record<string, ort.Tensor> = {}
  for (const name of names) {
    const t = candidates[name]
    if (!t) throw new Error(`ONNX 输入「${name}」不在候选集(input_ids/attention_mask/token_type_ids/pixel_values),请检查模型导出`)
    feeds[name] = t
  }
  return feeds
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
