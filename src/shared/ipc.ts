/* ================================================================
   IPC 契约 — 主进程 ↔ 渲染进程
   ================================================================ */

export interface EmbeddingConfig {
  provider: 'local' | 'openai' | 'zhipu' | 'qwen' | 'custom'
  modelName?: string
  dimensions?: number
  apiKey?: string
  baseUrl?: string
  concurrency?: number
  timeoutMs?: number
}

/* ================================================================
   DTO 行类型（R27：IPC 返回结构即契约，前端不再 as unknown as 断言）
   ================================================================ */

export interface FileListRow {
  id: string
  type: string
  category: string
  title: string
  source_path: string | null
  thumbnail_path: string | null
  url: string | null
  mime_type: string | null
  file_size: number | null
  created_at: number
  full_name: string
  ext: string
  modified_at: number
}

export interface FileListResult {
  rows: FileListRow[]
  total: number
  hasMore: boolean
  counts: Record<string, number>
}

export interface PlatformListRow {
  id: string
  title: string
  url: string
  platform: string
  thumbnail_path: string | null
  snippet: string
  tags: string[]
  image_urls: string[]
  created_at: number
}

export interface WatchTreeRow {
  watchPath: string
  name: string
  subDirs: { name: string; path: string }[]
}

export interface DuplicateGroupRow {
  id: number
  kind: 'exact' | 'near-image'
  files: string[]
  wastedBytes: number
  keepPath: string | null
}

export interface BatchRow {
  batchId: string
  count: number
  createdAt: number
}

export interface ContentDetail {
  id: string
  type: string
  title: string
  content: string
  source_path: string | null
  url: string | null
  platform: string | null
  mime_type: string | null
  file_size: number | null
  thumbnail_path: string | null
  ocr_text: string
  tags: string[]
  created_at: number
  ext?: string
  indexed_at: number | null
  meta: Record<string, unknown>
}

export interface NoteRow {
  id: number
  content_id: string
  anchor_text: string
  note: string
  color: string
  created_at: number
  updated_at: number
}

/* 单个在线模型服务配置（LLM / 多模态 / 嵌入共用形态） */
export interface OnlineModelConf {
  enabled: boolean
  provider: 'openai' | 'zhipu' | 'qwen' | 'custom'
  apiKey: string
  model: string
  baseUrl?: string
}

/* 统一在线服务商配置(百炼/智谱/自定义 OpenAI 兼容) */
export interface OnlineProviderConf {
  provider: 'bailian' | 'zhipu' | 'custom'
  apiKey: string
  /** custom 必填;内置服务商有默认值 */
  baseUrl: string
}

/* 按类别指派的在线模型(id 来自服务商模型列表) */
export interface ModelAssignments {
  /** 向量模型(文本语义检索) */
  embedding?: string
  /** 文本模型(LLM:AI 打标等) */
  text?: string
  /** 多模态模型(图片理解) */
  multimodal?: string
  /** 音频模型(预留) */
  audio?: string
}

/* 系统状态页总览 */
export interface SystemStatus {
  importedFiles: number
  pendingImport: number
  embedded: number
  pendingEmbed: number
  importFails: { name: string; reason: string }[]
  embedFails: { name: string; reason: string }[]
  models: {
    textEmbedding: string
    imageEmbedding: string
    textLlm: string
    multimodal: string
    audio: string
  }
}

export interface EmbeddingSettings {
  defaultProvider: 'local' | 'openai' | 'zhipu' | 'qwen' | 'custom'
  local: {
    clipModelPath: string
    bgeModelPath: string
  }
  providers: {
    openai: { enabled: boolean; apiKey: string; model: string; baseUrl?: string }
    zhipu: { enabled: boolean; apiKey: string; model: string }
    qwen: { enabled: boolean; apiKey: string; model: string }
    custom: { enabled: boolean; apiKey: string; model: string; baseUrl: string; dimensions: number }
  }
  /* 统一在线模型服务商接入(设置页):一份 Key 拉取模型列表后按类指派 */
  onlineProvider?: OnlineProviderConf
  modelAssignments?: ModelAssignments
  /* 在线文本模型（LLM）：文档 AI 打标等 */
  onlineLlm: OnlineModelConf
  /* 在线多模态模型：图片理解（预留，OCR 增强/图片描述） */
  onlineMultimodal: OnlineModelConf
  advanced: {
    autoReindexOnModelChange: boolean
    imageSearchStrategy: 'clip-only' | 'description-then-embed'
    batchSize: number
    onlineConcurrency: number
    timeoutMs: number
  }
}

export interface ContentItem {
  id: string
  type: 'file' | 'webpage' | 'note' | 'image'
  title: string
  content?: string
  sourcePath?: string
  url?: string
  platform?: string
  tags: string[]
  createdAt: number
  updatedAt: number
}

export interface SearchResult {
  id: string
  title: string
  snippet: string
  type: ContentItem['type']
  sourcePath?: string
  thumbnailPath?: string
  url?: string
  score: number
  createdAt: number
}

export interface FileIndexStatus {
  totalFiles: number
  indexedFiles: number
  pendingFiles: number
  isScanning: boolean
  lastScanAt: number | null
}

export interface ModelStatus {
  name: string
  downloaded: boolean
  downloading: boolean
  progress: number
  totalBytes: number
  downloadedBytes: number
}

export interface FailReason {
  reason: string
  count: number
}

export interface ImportProgress {
  phase: 'idle' | 'indexing' | 'embedding' | 'done'
  total: number
  done: number
  embedTotal: number
  embedDone: number
  percent: number
  sessionId: number
  /* 完成报告统计 */
  indexed: number
  skipped: number
  indexFailed: number
  indexFailReasons: FailReason[]
  embedded: number
  embedFailed: number
  embedFailReasons: FailReason[]
}

/* ---- 渲染进程可调用的 API ---- */
export interface OasisAPI {
  /* 内容检索 */
  search: {
    /** 以文搜文:type 缺省 'document'——搜索对象仅文档,图片/收藏/RSS 不掺入 */
    query(text: string, options?: { limit?: number; filters?: string[]; type?: 'all' | 'document' }): Promise<SearchResult[]>
    queryImage(imagePath: string, options?: { limit?: number }): Promise<SearchResult[]>
    /** 以文搜图：查询文本经 CLIP 文本编码器在图片空间检索（R18 通道,仅图片） */
    imagesByText(text: string, limit?: number): Promise<SearchResult[]>
    /** 以图搜图：查询图入媒体目录，返回可显示的协议 URL */
    stageQueryImage(path: string): Promise<string | null>
  }

  /* 视频检索（SentrySearch sidecar） */
  video: {
    init(params: { backend: 'qwen-cloud' | 'gemini' | 'local'; apiKey?: string; model?: string }): Promise<{
      ok: boolean
      backend: string
      dimensions: number
    }>
    index(params: { paths: string[]; chunkDuration?: number; overlap?: number }): Promise<{
      indexed_chunks: number
      skipped_still: number
      errors: { file: string; error: string }[]
    }>
    search(query: string, limit?: number): Promise<{
      results: { source_file: string; start_time: number; end_time: number; score: number }[]
    }>
    stats(): Promise<{ total_chunks: number; unique_source_files: number }>
    remove(sourceFile: string): Promise<{ removed: number }>
    onProgress(cb: (p: { file: string; chunk?: number; total_chunks?: number; skip?: string }) => void): () => void
  }

  /* 文件管理 */
  files: {
    list(dir?: string, opts?: { offset?: number; limit?: number; dir?: string; category?: string }): Promise<FileListResult>
    getStatus(): Promise<FileIndexStatus>
    pickDirectories(): Promise<string[]>
    addWatchPath(path: string): Promise<void>
    addWatchPaths(paths: string[]): Promise<void>
    removeWatchPath(path: string): Promise<void>
    getWatchPaths(): Promise<string[]>
    reindex(): Promise<void>
    reveal(path: string): void
    /** F01：内容详情（含 EXIF/OCR/错误状态与全文） */
    getDetail(id: string): Promise<ContentDetail | null>
    /** F03：阅读所需（收藏正文或订阅条目详情） */
    getReading(id: string): Promise<ContentDetail | null>
    listSubDirs(): Promise<WatchTreeRow[]>
    /** 重命名真实文件夹（fs.rename + 同步更新索引路径与监控表） */
    renameDir(oldPath: string, newName: string): Promise<{ newPath: string; movedCount: number }>
    /** 移除监控文件夹：取消监控 + 清索引，不动磁盘文件 */
    removeWatchDir(path: string): Promise<{ removedContents: number }>
  }

  /* 整理工作台 */
  organizer: {
    scan(roots: string[]): Promise<{ exactGroups: number; nearImageGroups: number; wastedBytes: number }>
    duplicates(status?: string): Promise<DuplicateGroupRow[]>
    rules(): Promise<unknown[]>
    /** F04：结构化规则保存 */
    saveRule(rule: {
      id?: number
      name: string
      category?: string
      pathPrefix?: string
      nameContains?: string
      action: 'move' | 'trash' | 'tag'
      target?: string
      tag?: string
      enabled?: boolean
    }): Promise<number>
    deleteRule(id: number): Promise<void>
    /** F04：建议预览 */
    listSuggestions(): Promise<{ id: number; file_path: string; action: string; target_path: string | null; reason: string; status: string }[]>
    /** F04：逐项撤销 */
    revertItem(logId: number): Promise<boolean>
    suggest(paths: string[]): Promise<number>
    execute(ids: number[]): Promise<{ batchId: string; done: number; failed: { path: string; error: string }[] }>
    trash(paths: string[]): Promise<{ batchId: string; done: number; failed: { path: string; error: string }[] }>
    revert(batchId: string): Promise<number>
    batches(): Promise<BatchRow[]>
    onProgress(cb: (p: { scanned: number; current: string }) => void): () => void
  }

  /* 设置 */
  settings: {
    getEmbedding(): Promise<EmbeddingSettings>
    setEmbedding(settings: EmbeddingSettings): Promise<void>
    getEncrypted(key: string): Promise<string | null>
    setEncrypted(key: string, value: string): Promise<void>
  }

  /* 平台收藏（L1 链接导入） */
  platform: {
    importLink(url: string): Promise<{ platform: string; title: string; created: boolean; id: string; images: number; video: boolean }>
    listPlugins(): Promise<{ id: string; label: string }[]>
    listContents(): Promise<PlatformListRow[]>
    /** 删除一条收藏(仅 webpage 类型):行/笔记/FTS/向量/缩略图级联清理 */
    remove(id: string): Promise<{ removed: boolean }>
    /** 重新抓取图文:全量下载图片/视频到本地并更新正文(保留标签) */
    refresh(id: string): Promise<{ ok: boolean; images: number; video: boolean }>
    /** 外部解析服务配置(XHS-Downloader / Douyin_TikTok_Download_API,可选) */
    mediaParser: {
      get(): Promise<{ xhs?: string; douyin?: string; builtinXhs?: boolean }>
      set(conf: { xhs?: string; douyin?: string; builtinXhs?: boolean }): Promise<void>
      test(base: string): Promise<boolean>
      /** 内置小红书引擎(XHS-Downloader,应用托管) */
      builtin: {
        status(): Promise<{ installed: boolean; running: boolean; enabled: boolean }>
        enable(): Promise<boolean>
        disable(): Promise<void>
      }
    }
    retag(): Promise<number>
  }

  /* F03：笔记与划线 */
  notes: {
    list(contentId: string): Promise<NoteRow[]>
    add(contentId: string, anchorText: string, note: string, color?: string): Promise<number>
    update(id: number, note: string): Promise<void>
    remove(id: number): Promise<void>
  }

  /* 导入进度轮询（事件推送的兜底通道） */
  importStatus(): Promise<ImportProgress>

  /* 模型 */
  models: {
    status(): Promise<ModelStatus[]>
    download(name: string): Promise<void>
  }

  /* 系统状态页 */
  status: {
    overview(): Promise<SystemStatus>
  }

  /* 在线模型服务商接入 */
  llm: {
    /** 测试连通并拉取模型列表(按名称启发式给出类别建议) */
    testProvider(input: { provider: 'bailian' | 'zhipu' | 'custom'; apiKey: string; baseUrl?: string }): Promise<
      { ok: true; models: { id: string; category: 'embedding' | 'text' | 'multimodal' | 'audio' | 'other' }[] } | { ok: false; error: string }
    >
  }

  /* 事件订阅 */
  on: {
    indexProgress(cb: (status: FileIndexStatus) => void): () => void
    modelProgress(cb: (status: ModelStatus) => void): () => void
    importProgress(cb: (p: ImportProgress) => void): () => void
    toast(cb: (msg: string, kind: 'info' | 'error') => void): () => void
  }
}

declare global {
  interface Window {
    oasis: OasisAPI
    oasisWebUtils: {
      getPathForFile(file: File): string
    }
  }
}
