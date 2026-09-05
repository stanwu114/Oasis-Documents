import type { OnlineModelConf } from '../shared/ipc'
import { getDb } from './db'
import { hydrateEmbeddingSettings } from './credentials'
import type { EmbeddingSettings } from '../shared/ipc'

/* ================================================================
   在线模型客户端（OpenAI 兼容协议）
   - 文本模型（LLM）：文档 AI 打标、（未来）摘要问答
   - 多模态模型：图片理解（预留）
   ================================================================ */

const PROVIDER_BASE: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
}

function baseUrlOf(conf: OnlineModelConf): string {
  return conf.baseUrl || PROVIDER_BASE[conf.provider] || ''
}

/** 读取设置中的在线文本模型配置（未启用返回 null）；经凭据还原拿真实 Key */
export function getOnlineLlm(): OnlineModelConf | null {
  const row = getDb().prepare(`SELECT value FROM settings WHERE key = 'embedding'`).get() as
    | { value: string }
    | undefined
  if (!row) return null
  const s = hydrateEmbeddingSettings(JSON.parse(row.value) as EmbeddingSettings)
  const conf = s.onlineLlm
  return conf?.enabled && conf.apiKey && conf.model ? conf : null
}

/** Chat 补全（OpenAI 兼容 /chat/completions） */
export async function llmChat(prompt: string, system: string, conf: OnlineModelConf): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await fetch(`${baseUrlOf(conf)}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conf.apiKey}` },
      body: JSON.stringify({
        model: conf.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt }
        ],
        temperature: 0.2,
        max_tokens: 300
      })
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`LLM API ${res.status}: ${body.slice(0, 200)}`)
    }
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    return json.choices?.[0]?.message?.content?.trim() ?? ''
  } finally {
    clearTimeout(timer)
  }
}
