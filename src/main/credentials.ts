import { safeStorage } from 'electron'
import { getDb } from './db'
import type { EmbeddingSettings } from '../shared/ipc'

/* ================================================================
   凭据服务（R26）：API Key 经 safeStorage 加密存储，
   配置 JSON 中只保存 __CRED__ 引用，所有读取方经 hydrate 还原
   ================================================================ */

export const CRED_REF = '__CRED__:'
const PLAIN_FALLBACK = '__PLAIN__'

const CRED_FIELDS = [
  'providers.openai.apiKey',
  'providers.zhipu.apiKey',
  'providers.qwen.apiKey',
  'providers.custom.apiKey',
  'onlineLlm.apiKey',
  'onlineMultimodal.apiKey'
] as const

function credKeyOf(path: string): string {
  return `cred:embedding:${path}`
}

function encryptValue(v: string): string {
  if (!safeStorage.isEncryptionAvailable()) return `${PLAIN_FALLBACK}${v}` /* 无钥匙串环境的降级标记 */
  return safeStorage.encryptString(v).toString('base64')
}

function decryptValue(stored: string): string | null {
  if (stored.startsWith(PLAIN_FALLBACK)) return stored.slice(PLAIN_FALLBACK.length)
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch {
    return null
  }
}

function getCred(s: EmbeddingSettings, path: string): string {
  const [a, b, c] = path.split('.')
  if (a === 'providers') {
    return ((s.providers as unknown as Record<string, Record<string, string>>)[b] ?? {})[c] ?? ''
  }
  return (s[a as 'onlineLlm' | 'onlineMultimodal'] as { apiKey?: string }).apiKey ?? ''
}

function setCred(s: EmbeddingSettings, path: string, v: string): void {
  const [a, b, c] = path.split('.')
  if (a === 'providers') {
    ;(s.providers as unknown as Record<string, Record<string, string>>)[b][c] = v
  } else {
    ;(s[a as 'onlineLlm' | 'onlineMultimodal'] as { apiKey?: string }).apiKey = v
  }
}

/** 保存配置：明文 Key → 加密凭据行；配置中只留引用 */
export function persistEmbeddingSettings(settings: EmbeddingSettings): void {
  const db = getDb()
  const putCred = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
  const clone: EmbeddingSettings = JSON.parse(JSON.stringify(settings))
  for (const field of CRED_FIELDS) {
    const raw = getCred(clone, field)
    if (raw && !raw.startsWith(CRED_REF)) {
      putCred.run(credKeyOf(field), encryptValue(raw))
      setCred(clone, field, CRED_REF)
    } else if (!raw) {
      setCred(clone, field, '')
    }
  }
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('embedding', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(JSON.stringify(clone))
}

/** 读取配置：引用 → 解密还原；发现存量明文自动迁移为加密 */
export function hydrateEmbeddingSettings(s: EmbeddingSettings): EmbeddingSettings {
  const db = getDb()
  const getCredRow = db.prepare(`SELECT value FROM settings WHERE key = ?`)
  const clone: EmbeddingSettings = JSON.parse(JSON.stringify(s))
  let changed = false
  for (const field of CRED_FIELDS) {
    const raw = getCred(clone, field)
    if (raw === CRED_REF) {
      const row = getCredRow.get(credKeyOf(field)) as { value: string } | undefined
      setCred(clone, field, row ? decryptValue(row.value) ?? '' : '')
    } else if (raw) {
      changed = true /* 存量明文，读取后顺手迁移 */
    }
  }
  if (changed) persistEmbeddingSettings(clone)
  return clone
}
