/** Read embedded JSON without evaluating scripts. Some SSR payloads contain JS undefined. */
export function parsePageJson(raw: string): unknown {
  let clean = '', quoted = false, escaped = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (quoted) {
      clean += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') quoted = false
    } else if (ch === '"') {
      quoted = true
      clean += ch
    } else if (raw.slice(i, i + 9) === 'undefined' && !/[\w$]/.test(raw[i - 1] ?? '') && !/[\w$]/.test(raw[i + 9] ?? '')) {
      clean += 'null'
      i += 8
    } else clean += ch
  }
  return JSON.parse(clean)
}

export function embeddedState(html: string, name: string): unknown | null {
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const [, attributes, script] = match
    try {
      if (new RegExp(`\\bid=["']${name}["']`).test(attributes)) {
        const raw = script.trim()
        return parsePageJson(raw.startsWith('%') ? decodeURIComponent(raw) : raw)
      }
      const assignment = new RegExp(`(?:window\\.)?${name}\\s*=\\s*`).exec(script)
      if (!assignment) continue
      const start = assignment.index + assignment[0].length
      let depth = 0, quoted = false, escaped = false
      for (let i = start; i < script.length; i++) {
        const ch = script[i]
        if (quoted) {
          if (escaped) escaped = false
          else if (ch === '\\') escaped = true
          else if (ch === '"') quoted = false
        } else if (ch === '"') quoted = true
        else if (ch === '{' || ch === '[') depth++
        else if ((ch === '}' || ch === ']') && --depth === 0) return parsePageJson(script.slice(start, i + 1))
      }
    } catch { /* never execute page code */ }
  }
  return null
}

export function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value)
    return /^https?:$/.test(url.protocol) ? url.href : undefined
  } catch { return undefined }
}

export function findObject(root: unknown, predicate: (o: Record<string, unknown>) => boolean): Record<string, unknown> | null {
  const queue: unknown[] = [root]
  for (let i = 0; i < queue.length && i < 10000; i++) {
    const value = queue[i]
    if (!value || typeof value !== 'object') continue
    const obj = value as Record<string, unknown>
    if (!Array.isArray(value) && predicate(obj)) return obj
    queue.push(...Object.values(obj).filter((v) => v && typeof v === 'object'))
  }
  return null
}
