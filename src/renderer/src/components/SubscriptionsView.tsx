import { useEffect, useState } from 'react'
import { Icon } from './Icon'
import { useUiStore } from '../stores/uiStore'

interface SubRow {
  id: number
  title: string
  feed_url: string
  unread: number
  last_fetch: number | null
}

interface ItemRow {
  id: string
  subscription_id: number
  title: string
  url: string
  author: string | null
  summary: string
  published_at: number
  read: number
  starred: number
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const now = Date.now()
  if (now - ts < 86400_000) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

export function SubscriptionsView(): React.ReactNode {
  const [subs, setSubs] = useState<SubRow[]>([])
  const [items, setItems] = useState<ItemRow[]>([])
  const [activeSub, setActiveSub] = useState<number | null>(null)
  const [onlyUnread, setOnlyUnread] = useState(false)
  const [newUrl, setNewUrl] = useState('')
  const [adding, setAdding] = useState(false)

  /* R24：筛选改为状态驱动——useEffect 依赖筛选条件，切换即用新参数请求，
     不再读取旧闭包状态 */
  useEffect(() => {
    void loadSubs()
  }, [])

  useEffect(() => {
    void loadItems()
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [activeSub, onlyUnread])

  const loadSubs = async (): Promise<void> => {
    setSubs(await window.oasis.subs.list())
  }
  const loadItems = async (): Promise<void> => {
    setItems(
      await window.oasis.subs.items({
        subId: activeSub ?? undefined,
        onlyUnread,
        limit: 100
      })
    )
  }

  const reload = async (): Promise<void> => {
    await Promise.all([loadSubs(), loadItems()])
  }

  const onAdd = async (): Promise<void> => {
    const u = newUrl.trim()
    if (!u) return
    setAdding(true)
    try {
      const r = await window.oasis.subs.add(u)
      useUiStore.getState().showToast(`已订阅「${r.title}」`)
      setNewUrl('')
      await reload()
    } catch (e) {
      useUiStore.getState().showToast(`订阅失败：${e instanceof Error ? e.message : e}`, 'error')
    } finally {
      setAdding(false)
    }
  }

  const openItem = async (item: ItemRow): Promise<void> => {
    /* F03：进入纯净阅读（详情内提供打开原文）；自动标已读 */
    useUiStore.getState().openDetail(`feed:${item.id}`)
    if (!item.read) {
      await window.oasis.subs.markRead(item.id, true)
      await reload()
    }
  }

  const totalUnread = subs.reduce((a, s) => a + s.unread, 0)

  return (
    <div className="view" style={{ maxWidth: 900 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
        <h1 className="view-title" style={{ margin: 0 }}>订阅时间线</h1>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="btn ghost"
            onClick={async () => {
              await window.oasis.subs.refresh()
              await reload()
              useUiStore.getState().showToast('已刷新全部订阅')
            }}
          >
            刷新
          </button>
        </div>
      </div>
      <p className="view-sub">
        RSS / Atom 订阅统一时间线{totalUnread > 0 ? `，${totalUnread} 条未读` : ''}。订阅文章与本地文件同框检索。
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input
          className="settings-input"
          style={{ flex: 1 }}
          placeholder="输入站点或 RSS 地址，如 https://blog.example.com"
          value={newUrl}
          onChange={(e) => setNewUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void onAdd()}
        />
        <button type="button" className="btn primary" onClick={() => void onAdd()} disabled={adding}>
          {adding ? '探测中…' : '订阅'}
        </button>
      </div>

      {/* 订阅源过滤 */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 18 }}>
        <button
          type="button"
          className={`btn small ${activeSub === null && !onlyUnread ? 'primary' : 'ghost'}`}
          onClick={() => { setActiveSub(null); setOnlyUnread(false); void loadItems() }}
        >
          全部
        </button>
        <button
          type="button"
          className={`btn small ${onlyUnread ? 'primary' : 'ghost'}`}
          onClick={() => { setOnlyUnread(!onlyUnread); void loadItems() }}
        >
          仅未读
        </button>
        {subs.map((s) => (
          <span key={s.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <button
              type="button"
              className={`btn small ${activeSub === s.id ? 'primary' : 'ghost'}`}
              onClick={() => { setActiveSub(s.id); void loadItems() }}
            >
              {s.title}
              {s.unread > 0 ? ` (${s.unread})` : ''}
            </button>
            <button
              type="button"
              title="退订"
              style={{ color: 'var(--fg-faint)', padding: '2px 4px' }}
              onClick={async () => {
                await window.oasis.subs.remove(s.id)
                if (activeSub === s.id) setActiveSub(null)
                await reload()
              }}
            >
              <Icon name="close" size={10} />
            </button>
          </span>
        ))}
      </div>

      {/* 时间线 */}
      <div className="search-results-list">
        {items.map((it) => (
          <div
            key={it.id}
            className="search-result-item"
            style={{
              cursor: 'pointer',
              opacity: it.read ? 0.62 : 1,
              background: it.read ? 'transparent' : 'var(--bg-subtle)'
            }}
            onClick={() => void openItem(it)}
          >
            <div className="search-result-body">
              <span className="search-result-title" style={{ fontWeight: it.read ? 500 : 600 }}>
                {it.title}
              </span>
              {it.summary ? <span className="search-result-snippet">{it.summary}</span> : null}
              <span style={{ fontSize: 11.5, color: 'var(--fg-faint)' }}>
                {it.author ? `${it.author} · ` : ''}{fmtTime(it.published_at)}
              </span>
            </div>
            <button
              type="button"
              title={it.starred ? '取消星标' : '星标'}
              style={{
                color: it.starred ? 'var(--accent)' : 'var(--fg-faint)',
                flexShrink: 0,
                fontSize: 16,
                padding: '2px 4px'
              }}
              onClick={async (e) => {
                e.stopPropagation()
                await window.oasis.subs.star(it.id, !it.starred)
                await loadItems()
              }}
            >
              {it.starred ? '★' : '☆'}
            </button>
          </div>
        ))}
        {items.length === 0 ? (
          <div className="search-results-empty">
            <Icon name="rss" size={28} />
            <p>{subs.length === 0 ? '添加一个 RSS 订阅源开始阅读' : '该筛选下没有条目'}</p>
          </div>
        ) : null}
      </div>
    </div>
  )
}
