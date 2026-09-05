# Oasis Documents — 双模式嵌入架构设计

## 核心决策

支持**本地 ONNX 推理**与**在线嵌入 API**两种模式，用户可在设置页自由切换默认引擎。向量库（LanceDB）与上层检索逻辑完全解耦，不关心向量来源。

```
┌────────────────────────────────────────────────────────────────┐
│                        设置页                                   │
│   嵌入模型来源: [○ 本地 ONNX] [○ 在线 API]                      │
│   ─────────────────────────────────────────────                │
│   若选「在线 API」:                                              │
│   ├─ 服务商: [OpenAI / 智谱 / 通义 / 自定义 OpenAI-Compatible]   │
│   ├─ API Key: [••••••••]                                       │
│   ├─ 模型名称: text-embedding-3-large                           │
│   ├─ 向量维度: 3072 (自动检测)                                   │
│   └─ 并发限制: 10 req/s                                        │
│   ─────────────────────────────────────────────                │
│   若选「本地 ONNX」:                                             │
│   ├─ 文本模型: BGE-small-zh-v1.5 (512 dim)                     │
│   ├─ 图文模型: CLIP-ViT-B-32 (512 dim)                         │
│   └─ 模型目录: ~/OasisDocuments/models/                        │
└────────────────────────────────────────────────────────────────┘
```

---

## 嵌入引擎接口设计

所有嵌入来源实现统一接口，上层调用方无感知差异。

```typescript
// src/main/embedder/types.ts
export interface EmbeddingConfig {
  provider: 'local' | 'openai' | 'zhipu' | 'qwen' | 'custom'
  // 通用字段
  modelName?: string
  dimensions?: number
  apiKey?: string
  baseUrl?: string      // 自定义 API 地址
  concurrency?: number  // 在线模式并发限制
  timeoutMs?: number
}

export interface Embedder {
  readonly config: EmbeddingConfig
  readonly isAvailable: boolean

  /** 嵌入文本，返回向量数组 */
  embedText(texts: string[]): Promise<number[][]>

  /** 嵌入图片（本地路径或 Buffer），返回向量数组 */
  embedImages(imagePaths: string[]): Promise<number[][]>

  /** 获取模型信息（维度、最大输入长度等） */
  getModelInfo(): Promise<ModelInfo>

  /** 预热/健康检查 */
  warmUp(): Promise<void>
}

export interface ModelInfo {
  name: string
  dimensions: number
  maxInputLength: number
  supportsImages: boolean
  supportsBatch: boolean
}
```

---

## 本地 ONNX 模式

### 运行方式
- `onnxruntime-node` 直接在 Electron 主进程中加载 `.onnx` 模型
- 文本和图片推理均在主进程完成，通过 IPC 向渲染进程返回结果

### 模型组合

| 模型 | 用途 | ONNX 大小 | 维度 | 来源 |
|------|------|-----------|------|------|
| CLIP-ViT-B-32 | 图片 → 向量 | ~300MB | 512 | openai/clip 社区 ONNX 转换 |
| BGE-small-zh-v1.5 | 文本 → 向量 | ~100MB | 512 | BAAI 官方 ONNX |

### 混合检索策略
- **以文搜图**：查询文本用 BGE 嵌入 → LanceDB 检索图片向量（图片向量由 CLIP 生成）
- 问题：BGE(512) 与 CLIP(512) 不在同一空间，不能直接比较
- **解决方案**：建立两个独立的向量空间
  - `image_vectors` 集合：CLIP 生成的图片向量（512 dim）
  - `text_vectors` 集合：BGE 生成的文本向量（512 dim）
  - 以文搜图时：文本经 BGE 嵌入后，在 `image_vectors` 中检索？不行，维度空间不同
  - **正确方案**：使用 CLIP 的文本编码器做图文对齐搜索，BGE 只做纯文本搜索

### 修正后的本地策略

| 检索场景 | 使用的模型 | 检索集合 |
|----------|-----------|----------|
| 以文搜文（文档/笔记） | BGE-small-zh | `content_vectors` (512 dim, BGE 空间) |
| 以文搜图 | CLIP 文本编码器 | `image_vectors` (512 dim, CLIP 空间) |
| 以图搜图 | CLIP 图片编码器 | `image_vectors` (512 dim, CLIP 空间) |
| 以图搜文 | CLIP 图片编码器 → 在文本侧用 CLIP 文本编码器索引 | `content_vectors_clip` (512 dim, CLIP 空间) |

即：文档/网页内容同时生成两套向量——BGE（纯语义）+ CLIP 文本编码器（图文对齐），分别存入不同集合。用户查询时根据场景路由到对应集合。

---

## 在线 API 模式

### 支持的服务商

| 服务商 | 代表模型 | 维度 | 支持图片 | 备注 |
|--------|----------|------|----------|------|
| **OpenAI** | text-embedding-3-large | 3072 | ❌ | 标杆，纯文本 |
| **OpenAI** | text-embedding-3-small | 1536 | ❌ | 便宜快速 |
| **智谱 AI** | embedding-3 | 2048 | ❌ | 中文优秀 |
| **通义千问** | text-embedding-v3 | 1024 / 768 | ❌ | 中文优秀，阿里云 |
| **Gemini** | text-embedding-004 | 768 | ❌ | Google |
| **Jina AI** | jina-embeddings-v3 | 1024 | ❌ | 开源模型 + API |
| **Ollama** | 任意本地模型 | 取决于模型 | 部分支持 | 通过 HTTP API 访问 |
| **自定义** | OpenAI-Compatible | 任意 | 取决于实现 | 兼容接口 |

> 注意：目前主流在线嵌入 API 均为**纯文本**，图片嵌入需额外处理（如先描述再嵌入，或调用多模态模型）。

### 在线模式的图片处理策略

由于在线嵌入 API 大多不支持直接嵌入图片，提供两种降级方案：

1. **描述后嵌入**（默认）：
   - 图片 → PaddleOCR 提取文字 + CLIP 本地生成描述词 → 文本 → 在线 API 嵌入
   - 优点：与纯文本内容统一向量空间
   - 缺点：丢失视觉特征

2. **保留本地 CLIP 用于图片**（推荐）：
   - 文本内容走在线 API（质量更高）
   - 图片向量仍由本地 CLIP 生成
   - 检索时：文本查询走在线 API 嵌入，在 `image_vectors`（CLIP 空间）中检索
   - 问题：在线文本向量与 CLIP 图片向量不在同一空间
   - **解决**：文本查询时，同时用本地 CLIP 文本编码器生成查询向量，用于图片检索

### 修正后的在线模式策略

```
文本内容索引:
  文档/网页文字 → 在线 API 嵌入 → content_vectors_online (dim 取决于服务商)

图片内容索引:
  图片 → 本地 CLIP 图片编码器 → image_vectors (512 dim, CLIP 空间)

检索时:
  文本查询「搜索图片」:
    → 本地 CLIP 文本编码器生成 512 dim 查询向量
    → 在 image_vectors (CLIP 空间) 中检索
  
  文本查询「搜索文档」:
    → 在线 API 嵌入查询文本
    → 在 content_vectors_online 中检索
```

> 这意味着：即使使用在线 API，本地仍需保留 CLIP 模型用于图片侧的向量生成和查询。CLIP 是图片搜索的不可替代组件。

---

## 向量存储 LanceDB 的集合设计

```typescript
// LanceDB 集合（Collection）设计

// 集合 1: 内容文本向量（可能有多个，对应不同嵌入来源）
interface ContentVector {
  id: string              // 内容唯一 ID
  contentId: string       // 关联的内容 ID（文档/网页/OCR 文本等）
  vector: Float32Array    // 文本嵌入向量
  source: 'bge' | 'openai' | 'zhipu' | ...  // 嵌入来源
  contentType: 'document' | 'webpage' | 'ocr' | 'note'
  createdAt: Date
}

// 集合 2: 图片向量（统一使用 CLIP 空间）
interface ImageVector {
  id: string
  contentId: string       // 关联的内容 ID
  vector: Float32Array    // CLIP 图片嵌入 (512 dim)
  imagePath: string       // 图片本地路径
  ocrText: string         // OCR 提取的文字（辅助全文检索）
  width: number
  height: number
  createdAt: Date
}

// 集合 3: 混合向量（用于在线模式的文本内容）
interface HybridVector {
  id: string
  contentId: string
  vector: Float32Array    // 在线 API 嵌入的向量
  source: string          // 服务商:modelName
  contentType: 'document' | 'webpage' | 'note'
  createdAt: Date
}
```

---

## 设置页配置数据模型

```typescript
// 存储在 SQLite settings 表中的配置
interface EmbeddingSettings {
  // 默认引擎
  defaultProvider: 'local' | 'openai' | 'zhipu' | 'qwen' | 'custom'

  // 本地模型配置
  local: {
    clipModelPath: string    // CLIP ONNX 路径
    bgeModelPath: string     // BGE ONNX 路径
    paddleOcrModelPath: string
  }

  // 各在线服务商配置（加密存储 API Key）
  providers: {
    openai: {
      enabled: boolean
      apiKey: string         // 加密存储
      model: 'text-embedding-3-large' | 'text-embedding-3-small' | 'text-embedding-ada-002'
      baseUrl?: string       // 自定义代理地址
    }
    zhipu: {
      enabled: boolean
      apiKey: string
      model: 'embedding-3'
    }
    qwen: {
      enabled: boolean
      apiKey: string
      model: 'text-embedding-v3'
    }
    custom: {
      enabled: boolean
      apiKey: string
      model: string
      baseUrl: string
      dimensions: number
    }
  }

  // 混合模式高级配置
  advanced: {
    // 是否对已有内容重新嵌入（切换模型时用）
    autoReindexOnModelChange: boolean
    // 图片搜索策略: 'clip-only' | 'description-then-embed'
    imageSearchStrategy: 'clip-only' | 'description-then-embed'
    // 批量嵌入并发数
    batchSize: number
    // 在线 API 并发限制
    onlineConcurrency: number
    // 超时时间
    timeoutMs: number
  }
}
```

---

## 切换模型时的迁移策略

当用户在设置页切换嵌入模型时：

1. **检测变更**：对比新旧配置是否改变
2. **询问用户**："切换嵌入模型将导致已有内容的向量失效。是否重新索引？"
3. **若选择重新索引**：
   - 标记所有内容为 `needsReindex = true`
   - 后台任务队列逐步重新嵌入
   - 新查询同时使用新旧向量空间（保证切换期间检索不中断）
4. **若选择不重新索引**：
   - 旧向量保留，新内容使用新模型
   - 检索时优先使用新模型的向量空间，fallback 到旧空间
   - 设置页提示："部分内容使用旧模型索引，建议重新索引以获得最佳效果"
5. **清理**：重新索引完成后，删除旧向量集合

---

## API Key 安全存储

- **存储位置**：SQLite settings 表
- **加密方式**：使用 Electron `safeStorage` 加密 API Key
  ```typescript
  import { safeStorage } from 'electron'
  const encrypted = safeStorage.encryptString(apiKey)
  const decrypted = safeStorage.decryptString(encrypted)
  ```
- `safeStorage` 在 macOS 使用 Keychain，Windows 使用 DPAPI，Linux 使用 Secret Service
- 这是 Electron 内置的、平台原生的加密方案

---

## 在线 API 调用封装

```typescript
// 统一封装，处理重试、限流、超时
class OnlineEmbedder implements Embedder {
  private client: AxiosInstance
  private semaphore: Semaphore  // 并发控制

  async embedText(texts: string[]): Promise<number[][]> {
    // 1. 过滤空文本
    // 2. 分批（服务商通常有 batch size 限制，如 OpenAI 最多 2048 个/批）
    // 3. 带重试的请求（指数退避，最多 3 次）
    // 4. 限流（semaphore 控制并发）
    // 5. 返回向量，顺序与输入一致
  }

  // 错误处理
  // - 401: API Key 无效 → 设置页提示
  // - 429: 速率限制 → 自动退避重试
  // - 5xx: 服务端错误 → 重试，fallback 到本地模型
  // - 网络超时 → fallback 到本地模型
}
```

**Fallback 策略**：在线 API 失败时，自动降级到本地 ONNX 模型（如果已下载），保证检索功能不中断。用户可在设置中关闭此行为。
