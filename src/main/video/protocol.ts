/* 视频 sidecar JSON-RPC 协议类型（与 resources/video-sidecar/bridge.py 对应） */

export type VideoBackend = 'qwen-cloud' | 'gemini' | 'local'

export interface VideoInitParams {
  backend: VideoBackend
  apiKey?: string
  model?: string
  dbPath?: string
}

export interface VideoInitResult {
  ok: boolean
  backend: VideoBackend
  dimensions: number
}

export interface VideoIndexParams {
  paths: string[]
  chunkDuration?: number
  overlap?: number
  skipStill?: boolean
}

export interface VideoIndexResult {
  indexed_chunks: number
  skipped_still: number
  errors: { file: string; error: string }[]
}

export interface VideoSearchHit {
  source_file: string
  start_time: number
  end_time: number
  score: number
}

export interface VideoSearchResult {
  results: VideoSearchHit[]
}

export interface VideoStats {
  total_chunks: number
  unique_source_files: number
}

/** sidecar 推送的事件 */
export type SidecarEvent =
  | { event: 'progress'; data: { file: string; chunk?: number; total_chunks?: number; skip?: string } }
  | { event: 'log'; data: { msg: string } }

/** RPC 响应行 */
export type SidecarResponse =
  | { id: number; result: unknown }
  | { id: number | null; error: string }
