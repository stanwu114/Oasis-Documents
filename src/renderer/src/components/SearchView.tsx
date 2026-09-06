import { useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import { MasonryGrid } from './MasonryGrid'
import { toMediaUrl } from '../lib/media'
import { useUiStore } from '../stores/uiStore'
import { highlightPattern } from '../../../shared/highlight'
import type { SearchResult } from '../../../shared/ipc'

type Mode = 'docs' | 'images' | 'byImage'

/** 相似度徽标文本：score（1-距离）钳制为 0–100% */
function simLabel(score: number): string {
  return `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`
}

export function SearchView(): React.ReactNode {
  const [mode, setMode] = useState<Mode>('docs')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searched, setSearched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [imagePath, setImagePath] = useState<string | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  /* Everything 式高亮:查询词元(含中文二元词片)命中处黄底标记 */
  const hl = useMemo(() => {
    const p = highlightPattern(query)
    return p ? new RegExp(`(${p})`, 'gi') : null
  }, [query])

  const runTextSearch = async (): Promise<void> => {
    const q = query.trim()
    if (q.length < 2) return
    setBusy(true)
    setSearched(true)
    try {
      /* R18：以文搜图走 CLIP 图文对齐通道;以文搜文仅检索文档;上限 200 条 */
      const r: SearchResult[] =
        mode === 'images'
          ? await window.oasis.search.imagesByText(q, 200)
          : await window.oasis.search.query(q, { limit: 200, type: 'document' })
      setResults(r)
    } finally {
      setBusy(false)
    }
  }

  const runImageSearch = async (file: File): Promise<void> => {
    const path = window.oasisWebUtils.getPathForFile(file)
    setBusy(true)
    setSearched(true)
    setImagePath(path)
    /* 查询图复制进媒体目录 → 白名单内可预览 */
    void window.oasis.search.stageQueryImage(path).then(setPreviewUrl)
    try {
      setResults(await window.oasis.search.queryImage(path, { limit: 200 }))
    } finally {
      setBusy(false)
    }
  }

  const resetImage = (): void => {
    setImagePath(null)
    setPreviewUrl(null)
    setResults([])
    setSearched(false)
  }

  /* 以文搜图/以图搜图(仅图片)用瀑布流卡片;以文搜文(仅文档)用列表 */
  const cardMode = mode === 'images' || mode === 'byImage'
  const cardItems = results.filter((r) => r.thumbnailPath || r.sourcePath)

  return (
    <div className="view" style={{ maxWidth: 940 }}>
      <h1 className="view-title">文件搜索</h1>
      <p className="view-sub">以文搜文（仅文档） · 以文搜图（仅图片） · 以图搜图（仅图片）</p>

      {/* 模式切换 */}
      <div className="seg" style={{ display: 'inline-flex', marginBottom: 16 }}>
        <button type="button" className={mode === 'docs' ? 'on' : ''} onClick={() => setMode('docs')}>以文搜文</button>
        <button type="button" className={mode === 'images' ? 'on' : ''} onClick={() => setMode('images')}>以文搜图</button>
        <button type="button" className={mode === 'byImage' ? 'on' : ''} onClick={() => setMode('byImage')}>以图搜图</button>
      </div>

      {/* 输入区 */}
      {mode === 'byImage' ? (
        imagePath ? (
          /* 已选图：显示预览 + 相似图检索中/结果 */
          <div className="query-preview">
            <div className="query-preview-img">
              {previewUrl ? (
                <img src={previewUrl} alt="查询图" />
              ) : (
                <div className="query-preview-loading">预览生成中…</div>
              )}
            </div>
            <div className="query-preview-side">
              <span className="query-preview-name">{imagePath.split('/').pop()}</span>
              <button type="button" className="btn small ghost" onClick={resetImage}>换一张</button>
            </div>
          </div>
        ) : (
          <div
            className="dropzone"
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              const f = e.dataTransfer.files[0]
              if (f) void runImageSearch(f)
            }}
          >
            <Icon name="image" size={30} />
            <p>拖拽图片到这里，或点击选择</p>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void runImageSearch(f)
              }}
            />
          </div>
        )
      ) : (
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          <input
            className="settings-input"
            style={{ flex: 1, padding: '9px 12px', fontSize: 14 }}
            placeholder={mode === 'images' ? '描述图片内容，如：橙色封面设计…' : '搜索文档：报告、笔记、代码、PDF…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void runTextSearch()}
          />
          <button type="button" className="btn primary" onClick={() => void runTextSearch()} disabled={busy || query.trim().length < 2}>
            {busy ? <span className="spin" /> : <Icon name="search" size={13} />}
            搜索
          </button>
        </div>
      )}

      {/* 结果 */}
      {searched ? (
        <>
          <div style={{ fontSize: 13, color: 'var(--fg-faint)', marginBottom: 12 }}>
            {busy ? '检索中…' : `${results.length} 条结果${cardMode ? ' · 按相似度排序' : ''}`}
          </div>

          {cardMode && cardItems.length > 0 ? (
            <ResultCards items={cardItems} re={hl} />
          ) : !cardMode && results.length > 0 ? (
            /* 以文搜文:结果均为文档,统一列表 */
            <div className="search-results-list">
              {results.map((r: SearchResult) => (
                <button
                  key={r.id}
                  type="button"
                  className="search-result-item"
                  onClick={() => useUiStore.getState().openDetail(r.id)}
                >
                  <Icon name={r.type === 'image' ? 'image' : 'doc'} size={15} />
                  <div className="search-result-body">
                    <span className="search-result-title">
                      <Highlight text={r.title} re={hl} />
                    </span>
                    {r.snippet ? (
                      <span className="search-result-snippet">
                        <Highlight text={r.snippet} re={hl} />
                      </span>
                    ) : null}
                  </div>
                  <span className="search-result-score">{simLabel(r.score)}</span>
                </button>
              ))}
            </div>
          ) : null}

          {!busy && ((cardMode && cardItems.length === 0) || (!cardMode && results.length === 0)) ? (
            <div className="search-results-empty">
              <Icon name="search" size={28} />
              <p>没有找到相关内容</p>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

/** 图片结果卡片墙(以文搜图/以图搜图共用;标题同样高亮命中词) */
function ResultCards({ items, re }: { items: SearchResult[]; re?: RegExp | null }): React.ReactNode {
  return (
    <MasonryGrid
      items={items.map((r) => ({ key: r.id }))}
      hasImage={() => true}
      render={(it, onImageLoad, style) => {
        const r = items.find((x) => x.id === it.key)
        if (!r) return null
        const thumb = r.thumbnailPath ? toMediaUrl(r.thumbnailPath) : r.sourcePath ? toMediaUrl(r.sourcePath) : undefined
        return (
          <button
            type="button"
            key={r.id}
            className="note-card"
            style={style}
            onClick={() => r.sourcePath && window.oasis.files.reveal(r.sourcePath)}
            title={r.title}
          >
            <div className="note-card-cover">
              {thumb ? (
                <img src={thumb} alt={r.title} loading="lazy" data-mkey={r.id} onLoad={(e) => onImageLoad(e.currentTarget)} />
              ) : null}
              <span className="sim-badge">{simLabel(r.score)}</span>
            </div>
            <div className="note-card-body">
              <span className="note-card-title">
                <Highlight text={r.title} re={re ?? null} />
              </span>
              <span className="note-card-meta">相似度 {simLabel(r.score)}</span>
            </div>
          </button>
        )
      }}
    />
  )
}

/** Everything 式关键词高亮:捕获组 split,奇数位即命中片段 */
function Highlight({ text, re }: { text: string; re: RegExp | null }): React.ReactNode {
  if (!text || !re) return <>{text}</>
  const parts = text.split(re)
  if (parts.length === 1) return <>{text}</>
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="console-highlight">{part}</mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  )
}
