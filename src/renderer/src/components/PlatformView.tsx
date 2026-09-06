import { useEffect, useState } from 'react'
import { Icon } from './Icon'
import { useUiStore } from '../stores/uiStore'
import { toMediaUrl } from '../lib/media'
import { MasonryGrid } from './MasonryGrid'

interface PlatformRow {
  id: string
  title: string
  url: string
  platform: string
  thumbnail_path: string | null
  snippet: string
  tags: string[]
  image_urls: string[]
  created_at: number
}

const PLATFORM_LABEL: Record<string, string> = {
  xiaohongshu: '小红书',
  douyin: '抖音',
  'wechat-mp': '公众号',
  csdn: 'CSDN'
}

function fmtDate(ts: number): string {
  const d = new Date(ts)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

export function PlatformView(): React.ReactNode {
  const [url, setUrl] = useState('')
  const [importing, setImporting] = useState(false)
  const [retagging, setRetagging] = useState(false)
  const [rows, setRows] = useState<PlatformRow[]>([])
  const [activeTag, setActiveTag] = useState<string | null>(null)

  useEffect(() => {
    void load()
  }, [])

  const load = async (): Promise<void> => {
    setRows(await window.oasis.platform.listContents())
  }

  const onImport = async (): Promise<void> => {
    const u = url.trim()
    if (!u) return
    setImporting(true)
    try {
      const r = await window.oasis.platform.importLink(u)
      useUiStore.getState().showToast(r.created ? `已导入「${r.title}」并完成 AI 打标` : '该链接已在收藏中')
      setUrl('')
      await load()
    } catch (e) {
      useUiStore.getState().showToast(`导入失败：${e instanceof Error ? e.message : e}`, 'error')
    } finally {
      setImporting(false)
    }
  }

  const onRetag = async (): Promise<void> => {
    setRetagging(true)
    try {
      const n = await window.oasis.platform.retag()
      useUiStore.getState().showToast(`已为 ${n} 条收藏重新 AI 打标`)
      await load()
    } finally {
      setRetagging(false)
    }
  }

  /* 全量标签云（点击过滤） */
  const tagCloud = [...new Set(rows.flatMap((r) => r.tags))].slice(0, 30)
  const filtered = activeTag ? rows.filter((r) => r.tags.includes(activeTag)) : rows

  return (
    <div className="platform-view">
      <div className="platform-head">
        <div>
          <h1 className="view-title">平台收藏</h1>
          <p className="view-sub" style={{ marginBottom: 0 }}>
            粘贴小红书 / 抖音 / 公众号 / CSDN 分享链接 · 导入时自动 AI 打标
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <button type="button" className="btn ghost" onClick={() => void onRetag()} disabled={retagging || rows.length === 0}>
            {retagging ? '打标中…' : '重新 AI 打标'}
          </button>
        </div>
      </div>

      <div className="platform-import-bar">
        <input
          className="settings-input"
          style={{ flex: 1 }}
          placeholder="直接粘贴整段分享文案（自动识别链接，支持小红书 / 抖音 / 公众号 / CSDN）"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void onImport()}
        />
        <button type="button" className="btn primary" onClick={() => void onImport()} disabled={importing}>
          {importing ? '解析中…' : '导入'}
        </button>
      </div>

      {tagCloud.length > 0 ? (
        <div className="platform-tagcloud">
          <button
            type="button"
            className={`tag-chip${activeTag === null ? ' on' : ''}`}
            onClick={() => setActiveTag(null)}
          >
            全部 {rows.length}
          </button>
          {tagCloud.map((t) => (
            <button key={t} type="button" className={`tag-chip${activeTag === t ? ' on' : ''}`} onClick={() => setActiveTag(activeTag === t ? null : t)}>
              #{t}
            </button>
          ))}
        </div>
      ) : null}

      {filtered.length > 0 ? (
        <MasonryGrid
          items={filtered.map((r) => ({ key: r.id }))}
          hasImage={(it) => Boolean(filtered.find((x) => x.id === it.key)?.thumbnail_path)}
          render={(_it, onImageLoad, style) => {
            const r = filtered.find((x) => x.id === _it.key)
            if (!r) return null
            return (
              <a
                key={r.id}
                className="note-card"
                style={style}
                href={r.url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => {
                  /* F03：卡片进入纯净阅读，详情内保留「打开原文」直达 */
                  e.preventDefault()
                  useUiStore.getState().openDetail(r.id)
                }}
              >
                <div className={`note-card-cover ${r.thumbnail_path ? '' : 'placeholder'}`}>
                  {r.thumbnail_path ? (
                    <img
                      src={toMediaUrl(r.thumbnail_path) ?? undefined}
                      alt={r.title}
                      loading="lazy"
                      data-mkey={r.id}
                      onLoad={(e) => onImageLoad(e.currentTarget)}
                    />
                  ) : (
                    <span className="note-card-cover-platform">
                      <Icon name="doc" size={26} />
                      <em>{PLATFORM_LABEL[r.platform] ?? r.platform}</em>
                    </span>
                  )}
                  <span className="note-card-badge">{PLATFORM_LABEL[r.platform] ?? r.platform}</span>
                </div>
                <div className="note-card-body">
                  <span className="note-card-title">{r.title}</span>
                  {r.snippet ? <span className="note-card-desc">{r.snippet}</span> : null}
                  {r.tags.length > 0 ? (
                    <div className="note-card-tags">
                      {r.tags.slice(0, 4).map((t) => (
                        <span key={t} className="note-tag">#{t}</span>
                      ))}
                    </div>
                  ) : null}
                  <span className="note-card-meta">{fmtDate(r.created_at)}</span>
                </div>
              </a>
            )
          }}
        />
      ) : (
        <div className="search-results-empty">
          <Icon name="doc" size={28} />
          <p>{rows.length === 0 ? '还没有平台收藏，粘贴链接开始导入' : '该标签下暂无内容'}</p>
        </div>
      )}
    </div>
  )
}
