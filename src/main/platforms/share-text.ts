/* ================================================================
   分享文案解析：用户粘贴的往往不是纯链接，而是整段分享文本
   「7.98 pQg:/ 复制打开抖音，看看【xx的作品】#装修 https://v.douyin.com/abc/」
   → 提取 URL（容忍中文包围/尾随）+ 清洗口令文案 + 抽取 #话题
   ================================================================ */

export interface ShareInfo {
  url: string | null
  text: string /* 去 URL、去口令词后的描述文案 */
  hashtags: string[] /* 文案里的 #话题 */
}

/* 带协议的 URL：遇空白/中文/常见右括号引号即截止（处理「链接后紧跟中文」） */
const URL_RE = /https?:\/\/[^\s\u4e00-\u9fff<>"')，。！？、]+/i
/* 裸域名（无协议粘贴）：www 开头或已知平台域 */
const BARE_RE = /(?:www\.|[a-z0-9-]+\.)*(?:xiaohongshu|douyin|xhslink|iesdouyin|csdn|weixin\.qq|mp\.weixin)\b[^\s\u4e00-\u9fff<>"')，。！？、]*/i

/* 平台引导口令（抖音"复制打开"、小红书"帮我看看"等） */
const NOISE_RE = [
  /复制打开[^\s，,]*/g,
  /复制此链接/g,
  /打开[抖小][音红]书/g,
  /帮我看看/g,
  /看看【[^】]*】|【[^】]*】/g,
  /看看/g,
  /的(作品|主页|视频)/g,
  /^\s*[\d.]+\s+[\w]+:\/\S*\s*/ /* 开头口令码，如「7.98 pQg:/」 */
]

export function parseShareText(input: string): ShareInfo {
  const raw = input.trim()
  if (!raw) return { url: null, text: '', hashtags: [] }

  let url: string | null = null
  let rest = raw

  const withProto = raw.match(URL_RE)
  if (withProto) {
    url = withProto[0]
    rest = rest.replace(url, ' ')
  } else {
    const bare = raw.match(BARE_RE)
    if (bare) {
      url = bare[0].startsWith('http') ? bare[0] : `https://${bare[0]}`
      rest = rest.replace(bare[0], ' ')
    }
  }

  /* 清洗口令噪音 */
  for (const re of NOISE_RE) rest = rest.replace(re, ' ')
  rest = rest.replace(/\s+/g, ' ').trim()
  /* 去掉孤立口令码残留（含 : 或 / 的短字母数字 token，URL 已先行移除，剩下的都是口令码） */
  rest = rest
    .split(' ')
    .filter((tok) => !(tok.length <= 14 && /^[a-zA-Z0-9.:/]+$/.test(tok) && /[:/]/.test(tok)))
    .filter((tok) => tok.length > 1 || /[\u4e00-\u9fff]/.test(tok))
    .join(' ')
    .replace(/\s*[，,。！!！]\s*(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const hashtags = [...rest.matchAll(/#([^\s#,，、]+)/g)].map((m) => m[1]).slice(0, 8)

  return { url, text: rest, hashtags }
}
