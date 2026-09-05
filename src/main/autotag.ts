/* ================================================================
   AI 自动打标签
   - 本地：关键短语抽取（零成本离线，无 LLM 时的 fallback）
   - 在线：文本模型（LLM）归纳打标（设置 → 在线模型 → 文本模型）
   策略（本地）：标题加权 × 3 + 正文 → 中文 n-gram(2-4字) 与英文词
        分别统计频次 → 停用词/子串去重 → 频次×标题加权的复合得分
   ================================================================ */

import type { OnlineModelConf } from '../shared/ipc'

const STOP_WORDS = new Set([
  '我们', '你们', '他们', '这个', '那个', '一个', '可以', '没有', '什么', '自己',
  '如何', '怎么', '为什么', '还是', '因为', '所以', '但是', '如果', '就是',
  '一下', '一些', '非常', '特别', '真的', '觉得', '知道', '时候', '东西',
  'the', 'and', 'for', 'you', 'with', 'this', 'that', 'from', 'have', 'will',
  'your', 'are', 'was', 'how', 'what', 'when', 'which', 'they', 'them', 'then',
  'into', 'about', 'just', 'like', 'some', 'more', 'very', 'also', 'than'
])

/** 从标题+正文抽取自动标签（top n） */
export function autoTag(title: string, content: string, n = 5): string[] {
  const text = `${title}\n${title}\n${title}\n${content}`.slice(0, 20_000) // 标题 ×3 加权（重复计入频次）
  if (!text.trim()) return []

  const freq = new Map<string, { count: number; inTitle: boolean }>()

  /* 英文/数字词（保留 # 开头的话题形式） */
  for (const m of text.matchAll(/[a-zA-Z][a-zA-Z0-9+#.\-]{1,20}/g)) {
    const word = m[0].toLowerCase()
    if (STOP_WORDS.has(word) || word.length < 3) continue
    bump(freq, word)
  }

  /* 中文 n-gram(2-4)：对每段连续中文抽取候选短语 */
  for (const seg of text.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const s = seg[0]
    for (let len = 2; len <= Math.min(4, s.length); len++) {
      for (let i = 0; i + len <= s.length; i++) {
        const gram = s.slice(i, i + len)
        if (STOP_WORDS.has(gram)) continue
        /* 含常见功能字的 n-gram 降权跳过（的地得了吗呢吧啊） */
        if (/[的地得了吗呢吧啊嘛么于是在把被和与或]/.test(gram)) continue
        bump(freq, gram)
      }
    }
  }

  /* 子串去重：短词若是某个更高频长词的子串且得分更低，则丢弃 */
  const scored = [...freq.entries()].map(([tag, v]) => {
    const inTitle = title.includes(tag)
    const score = v.count * (inTitle ? 2.2 : 1) * (tag.length >= 3 ? 1.3 : 1)
    return { tag, score, inTitle }
  })
  scored.sort((a, b) => b.score - a.score)

  const picked: { tag: string; score: number }[] = []
  for (const cand of scored) {
    if (picked.length >= n) break
    /* 已选标签是自己的子串/超串 → 跳过冗余 */
    const redundant = picked.some(
      (p) => p.tag.includes(cand.tag) || cand.tag.includes(p.tag)
    )
    if (redundant) continue
    if (cand.score < 2) break /* 频次过低无代表性 */
    picked.push(cand)
  }
  return picked.map((p) => p.tag)
}

function bump(freq: Map<string, { count: number; inTitle: boolean }>, tag: string): void {
  const cur = freq.get(tag)
  if (cur) cur.count++
  else freq.set(tag, { count: 1, inTitle: false })
}

/** 平台原生标签 + AI 标签合并去重（AI 的排前面，原生话题保留 # 形式） */
export function mergeTags(aiTags: string[], platformTags: string[], limit = 8): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const norm = (t: string): string => t.toLowerCase().replace(/^[#\s]+/, '')
  for (const t of [...aiTags, ...platformTags]) {
    const k = norm(t)
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(t)
    if (out.length >= limit) break
  }
  return out
}

/* ================================================================
   智能打标：在线文本模型（LLM）优先，未配置/失败回退本地抽取
   ================================================================ */

const LLM_SYSTEM = '你是内容标注助手。为给定内容输出 3-6 个最具代表性的主题标签。要求：中文、2-6 个字、具体不空泛（如"极简装修""K8s 运维""儿童教育"）、不重复内容里的口水词。只输出 JSON 数组，如 ["标签1","标签2"]，不要任何其他文字。'

/** LLM 归纳打标（解析失败抛错由调用方回退） */
export async function autoTagByLlm(title: string, content: string, conf: OnlineModelConf): Promise<string[]> {
  const { llmChat } = await import('./llm')
  const digest = `标题：${title}\n\n内容：${content.replace(/\s+/g, ' ').slice(0, 1500)}`
  const raw = await llmChat(digest, LLM_SYSTEM, conf)
  /* 从回复中抠出 JSON 数组（容忍 markdown 代码块包裹） */
  const m = raw.match(/\[[\s\S]*?\]/)
  if (!m) throw new Error('LLM 未返回标签数组')
  const tags = JSON.parse(m[0]) as unknown[]
  return tags
    .filter((t): t is string => typeof t === 'string' && t.trim().length >= 2 && t.trim().length <= 12)
    .map((t) => t.trim())
    .slice(0, 6)
}

/** 统一入口：配置了在线文本模型走 LLM，否则/失败走本地关键短语 */
export async function autoTagSmart(title: string, content: string): Promise<{ tags: string[]; engine: 'llm' | 'local' }> {
  const { getOnlineLlm } = await import('./llm')
  const conf = getOnlineLlm()
  if (conf) {
    try {
      const tags = await autoTagByLlm(title, content, conf)
      if (tags.length > 0) return { tags, engine: 'llm' }
    } catch (e) {
      console.warn('[autotag] LLM 打标失败，回退本地:', e instanceof Error ? e.message : e)
    }
  }
  return { tags: autoTag(title, content), engine: 'local' }
}
