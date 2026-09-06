/* ================================================================
   在线模型服务商接入(百炼/智谱/自定义 OpenAI 兼容)
   - 统一 API Key,测试连通 = 拉取 /models 列表鉴权成功
   - 拉到的模型列表按名称启发式分类,供设置页按类指派
   ================================================================ */

export interface ProviderPreset {
  id: 'bailian' | 'zhipu' | 'custom'
  label: string
  baseUrl: string
  keyHint: string
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'bailian', label: '百炼（阿里 DashScope）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyHint: 'sk-…（百炼控制台 → API-KEY）' },
  { id: 'zhipu', label: '智谱（BigModel）', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyHint: '…（智谱开放平台 → API Key）' },
  { id: 'custom', label: '自定义（OpenAI 兼容）', baseUrl: '', keyHint: 'sk-…' }
]

export type ModelCategory = 'embedding' | 'text' | 'multimodal' | 'audio' | 'other'

/** 模型 id → 类别启发式(顺序敏感:先专项后泛化) */
export function categorizeModel(id: string): ModelCategory {
  const s = id.toLowerCase()
  if (/embedding|bge-|m3e|gte-text|text-embed/.test(s)) return 'embedding'
  if (/audio|asr|speech|tts|voice|whisper|paraformer|sensevoice/.test(s)) return 'audio'
  if (/-vl|vl-|vision|multimodal|omni|4v|image|-cv\b/.test(s)) return 'multimodal'
  if (/qwen|glm|gpt|deepseek|llama|kimi|ernie|moonshot|doubao|hunyuan|chat|instruct|flash|turbo|-plus|-max|-pro|-mini|reasoning/.test(s)) return 'text'
  return 'other'
}

export interface ProviderTestResult {
  ok: boolean
  models: { id: string; category: ModelCategory }[]
  error?: string
}

/** 测试连通并拉取模型列表(GET /models,Bearer 鉴权) */
export async function testProviderConnection(input: {
  provider: 'bailian' | 'zhipu' | 'custom'
  apiKey: string
  baseUrl?: string
}): Promise<ProviderTestResult> {
  const preset = PROVIDER_PRESETS.find((p) => p.id === input.provider)
  const base = (input.baseUrl || preset?.baseUrl || '').replace(/\/+$/, '')
  if (!input.apiKey.trim()) return { ok: false, models: [], error: '请先填写 API Key' }
  if (!base) return { ok: false, models: [], error: '请填写 Base URL' }

  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 12_000)
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${input.apiKey}` },
      signal: ctrl.signal
    })
    clearTimeout(timer)
    if (!res.ok) {
      const detail = res.status === 401 ? '鉴权失败：API Key 无效' : res.status === 404 ? '该服务商不支持 /models 列表接口（可手动填写模型名）' : `HTTP ${res.status}`
      return { ok: false, models: [], error: detail }
    }
    const json = (await res.json()) as { data?: { id?: string }[] }
    const models = (json.data ?? [])
      .map((m) => m.id ?? '')
      .filter(Boolean)
      .sort()
      .map((id) => ({ id, category: categorizeModel(id) }))
    return { ok: true, models }
  } catch (e) {
    const msg = e instanceof Error ? (e.name === 'AbortError' ? '连接超时（12 秒）' : e.message) : String(e)
    return { ok: false, models: [], error: `无法连接服务商：${msg}` }
  }
}
