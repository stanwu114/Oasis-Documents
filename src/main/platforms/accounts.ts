import { BrowserWindow } from 'electron'
import { getDb } from '../db'
import { addSubscription } from '../subscriptions/rss'

/* ================================================================
   L3 平台账号框架（报告 11.4：L1/L2 已稳定后启用；封号风险需明示）
   - 登录窗口使用独立持久 session（persist:platform-<id>），
     登录态跨重启保留；仅承载登录，不做自动抓取
   - 公众号 RSSHub 桥接：以 RSS 订阅方式同步指定公众号文章（安全路径）
   - 每次动作写 sync_logs 可追溯
   ================================================================ */

export interface PlatformAccount {
  id: string
  label: string
  loginUrl: string
  /** 登录成功后的特征 URL（检测登录态用） */
  homeUrl: string
}

export const PLATFORM_ACCOUNTS: PlatformAccount[] = [
  { id: 'xiaohongshu', label: '小红书', loginUrl: 'https://www.xiaohongshu.com', homeUrl: 'https://www.xiaohongshu.com' },
  { id: 'douyin', label: '抖音', loginUrl: 'https://www.douyin.com', homeUrl: 'https://www.douyin.com' },
  { id: 'csdn', label: 'CSDN', loginUrl: 'https://passport.csdn.net/login', homeUrl: 'https://i.csdn.net' }
]

/** 打开平台登录窗口（独立持久 session，登录态跨重启保留） */
export async function openPlatformLogin(accountId: string): Promise<boolean> {
  const acc = PLATFORM_ACCOUNTS.find((a) => a.id === accountId)
  if (!acc) throw new Error(`未知平台: ${accountId}`)

  const win = new BrowserWindow({
    width: 1100,
    height: 780,
    title: `登录 ${acc.label} — Oasis Documents`,
    webPreferences: {
      partition: `persist:platform-${acc.id}`,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  await win.loadURL(acc.loginUrl)

  getDb()
    .prepare(`INSERT INTO sync_logs (platform, status, message, items_count, created_at) VALUES (?, 'success', '打开登录窗口', 0, ?)`)
    .run(acc.id, Date.now())
  return true
}

/** 公众号 RSSHub 订阅（L3 安全路径：不碰微信登录态，走 RSS 桥接） */
export async function subscribeWechatMp(mpName: string, rsshubBase?: string): Promise<{ id: number; feedUrl: string }> {
  const base = (rsshubBase || 'https://rsshub.app').replace(/\/$/, '')
  const feedUrl = `${base}/wechat/mp/${encodeURIComponent(mpName)}`
  const r = await addSubscription(feedUrl)
  getDb()
    .prepare(`INSERT INTO sync_logs (platform, status, message, items_count, created_at) VALUES (?, 'success', ?, 1, ?)`)
    .run('wechat-mp', `RSSHub 订阅公众号: ${mpName}`, Date.now())
  return { id: r.id, feedUrl }
}

/** 平台账号状态（登录窗口是否曾打开过——session 是否存在不直接探测，记录为准） */
export function accountActivity(): { id: string; label: string; lastAction: number | null }[] {
  const db = getDb()
  return PLATFORM_ACCOUNTS.map((a) => {
    const row = db
      .prepare(`SELECT MAX(created_at) AS t FROM sync_logs WHERE platform = ?`)
      .get(a.id) as { t: number | null }
    return { id: a.id, label: a.label, lastAction: row.t }
  })
}
