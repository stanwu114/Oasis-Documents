import { stat } from 'node:fs/promises'
import { extname, basename } from 'node:path'
import { lookup } from 'mime-types'
import { getDb } from '../db'

/* ================================================================
   声明式整理规则引擎
   规则以 YAML 文本存储于 organize_rules 表，UI 提供编辑器
   ================================================================ */

export interface RuleCondition {
  path?: string
  path_prefix?: string
  mime?: string
  ext?: string[]
  name_matches?: string
  size_above?: number
  size_below?: number
  last_accessed_before?: string
  last_accessed_after?: string
}

export interface OrganizeRule {
  id: number
  name: string
  enabled: boolean
  priority: number
  when: RuleCondition
  suggest: string
  action: 'move' | 'trash' | 'tag'
  tag?: string
}

export interface Suggestion {
  ruleId: number
  ruleName: string
  filePath: string
  action: 'move' | 'trash' | 'tag'
  targetPath: string | null
  tag: string | null
  reason: string
}

/* ---- 内嵌极简 YAML 子集解析（避免引入 js-yaml 依赖） ----
   支持的规则文件形如：
     name: 截图归档
     when:
       path_prefix: ~/Desktop
       mime: image/*
       name_matches: 屏幕快照|Screenshot
     suggest: ~/Documents/截图/{YYYY}/{MM}
   说明：真实 YAML 依赖 js-yaml 更稳妥，这里先用行式解析跑通 MVP，
   后续引入 js-yaml 时只需替换 parseRuleYaml。
---------------------------------------------------------------- */

interface ParsedRule {
  name?: string
  when?: RuleCondition
  suggest?: string
  action?: string
  tag?: string
}

export function parseRuleYaml(yaml: string): ParsedRule {
  const out: ParsedRule = {}
  let section = ''
  for (const rawLine of yaml.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trimEnd()
    if (!line.trim()) continue
    const indent = line.length - line.trimStart().length
    const trimmed = line.trim()
    const m = trimmed.match(/^([\w-]+):\s*(.*)$/)
    if (!m) continue
    const [, key, value] = m
    if (indent === 0) {
      if (key === 'when') {
        section = 'when'
        out.when = {}
      } else {
        section = ''
        if (key === 'name') out.name = value
        else if (key === 'suggest') out.suggest = value
        else if (key === 'action') out.action = value
        else if (key === 'tag') out.tag = value
      }
    } else if (section === 'when' && out.when) {
      const cond = out.when as Record<string, unknown>
      if (key === 'ext') {
        cond.ext = value.split(',').map((s) => s.trim())
      } else if (key === 'size_above' || key === 'size_below') {
        cond[key] = parseSize(value)
      } else {
        cond[key] = value
      }
    }
  }
  return out
}

function parseSize(v: string): number {
  const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?$/i)
  if (!m) return 0
  const n = parseFloat(m[1])
  const unit = (m[2] ?? 'B').toUpperCase()
  const mult = unit === 'GB' ? 1024 ** 3 : unit === 'MB' ? 1024 ** 2 : unit === 'KB' ? 1024 : 1
  return Math.round(n * mult)
}

function parseRelativeTime(v: string): number {
  const m = v.trim().match(/^(\d+)\s*(天|周|月|年|d|w|m|y)$/i)
  if (!m) return 0
  const n = parseInt(m[1], 10)
  const unit = m[2].toLowerCase()
  const ms =
    unit === '年' || unit === 'y' ? 365 * 86400_000 :
    unit === '月' || unit === 'm' ? 30 * 86400_000 :
    unit === '周' || unit === 'w' ? 7 * 86400_000 :
    86400_000
  return Date.now() - n * ms
}

/** 展开目标路径模板：~/、{YYYY}、{MM}、{EXT} 等 */
export function expandTarget(template: string, filePath: string): string {
  const now = new Date()
  const replaced = template
    .replace(/^~(?=\/)/, process.env.HOME ?? '~')
    .replace(/\{YYYY\}/g, String(now.getFullYear()))
    .replace(/\{MM\}/g, String(now.getMonth() + 1).padStart(2, '0'))
    .replace(/\{DD\}/g, String(now.getDate()).padStart(2, '0'))
    .replace(/\{EXT\}/g, extname(filePath).slice(1).toLowerCase() || 'noext')
    .replace(/\{NAME\}/g, basename(filePath, extname(filePath)))
  return replaced
}

/* MIME 等通配匹配已内联到各条件判断中（R09 修复后不再需要独立函数） */

/** 判断单个文件是否命中规则条件 */
export async function matchesCondition(
  filePath: string,
  cond: RuleCondition
): Promise<boolean> {
  const name = basename(filePath)
  const ext = extname(filePath).toLowerCase()

  if (cond.ext && !cond.ext.includes(ext)) return false

  if (cond.mime) {
    const mime = lookup(filePath) || 'application/octet-stream'
    /* R09：mime 的 '/' 是字面分隔符不做转义，仅 '*' 作通配；
       旧实现对 '/' 双重转义导致 image/* 永远不匹配 */
    const re = new RegExp(`^${cond.mime.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i')
    if (!re.test(mime)) return false
  }

  if (cond.name_matches && !new RegExp(cond.name_matches, 'i').test(name)) return false

  const dir = filePath.slice(0, filePath.lastIndexOf('/'))
  if (cond.path_prefix) {
    const prefix = expandTarget(cond.path_prefix, filePath)
    if (!dir.startsWith(prefix.replace(/\/$/, ''))) return false
  }

  let s
  try {
    s = await stat(filePath)
  } catch {
    return false
  }
  if (cond.size_above !== undefined && s.size <= cond.size_above) return false
  if (cond.size_below !== undefined && s.size >= cond.size_below) return false

  if (cond.last_accessed_before) {
    const threshold = parseRelativeTime(cond.last_accessed_before)
    if (s.atimeMs > threshold) return false
  }
  if (cond.last_accessed_after) {
    const threshold = parseRelativeTime(cond.last_accessed_after)
    if (s.atimeMs < threshold) return false
  }
  return true
}

/** 加载启用中的规则并按优先级排序 */
export function loadRules(): OrganizeRule[] {
  const db = getDb()
  const rows = db
    .prepare(`SELECT id, name, enabled, priority, rule_yaml FROM organize_rules WHERE enabled = 1 ORDER BY priority DESC`)
    .all() as { id: number; name: string; enabled: number; priority: number; rule_yaml: string }[]
  return rows.flatMap((r) => {
    const parsed = parseRuleYaml(r.rule_yaml)
    if (!parsed.when || !parsed.suggest) return []
    return [{
      id: r.id,
      name: parsed.name ?? r.name,
      enabled: !!r.enabled,
      priority: r.priority,
      when: parsed.when,
      suggest: parsed.suggest,
      action: (parsed.action as OrganizeRule['action']) ?? (parsed.suggest === 'trash' ? 'trash' : 'move'),
      tag: parsed.tag
    }]
  })
}

/** 对一批文件跑规则引擎 → 写入 organize_suggestions（pending），返回建议数 */
export async function generateSuggestions(filePaths: string[]): Promise<number> {
  const db = getDb()
  const rules = loadRules()
  const insert = db.prepare(`
    INSERT INTO organize_suggestions (rule_id, file_path, action, target_path, reason, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `)

  let count = 0
  for (const fp of filePaths) {
    for (const rule of rules) {
      if (await matchesCondition(fp, rule.when)) {
        const target =
          rule.action === 'trash' ? null : expandTarget(rule.suggest, fp)
        insert.run(rule.id, fp, rule.action, target, `规则「${rule.name}」`, Date.now())
        count++
        break // 单文件只取优先级最高的规则
      }
    }
  }
  return count
}
