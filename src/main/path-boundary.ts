/* 目录边界判定（R02）：仅匹配根本身或 root + '/' 开头——
   前缀 LIKE 会把 work 误伤为 work-old；无依赖，供 IPC 与测试使用 */

export function isUnderRoot(path: string | null | undefined, root: string): boolean {
  if (!path) return false
  return path === root || path.startsWith(`${root}/`)
}
