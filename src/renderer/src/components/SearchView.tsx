import { useRef, useState } from 'react'
import { Icon } from './Icon'
import type { SearchResult } from '../../../shared/ipc'

type Mode = 'all' | 'images' | 'byImage'

export function SearchView(): React.ReactNode {
  const [mode, setMode] = useState<Mode>('all')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searched, setSearched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [imagePath, setImagePath] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const runTextSearch = async (): Promise<void> => {
    const q = query.trim()
    if (q.length < 2) return
    setBusy(true)
    setSearched(true)
    try {
      const r: SearchResult[] =
        mode === 'images'
          ? await window.oasis.search.imagesByText(q, 40)
          : await window.oasis.search.query(q, { limit: 40 })
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
    try {
      setResults(await window.oasis.search.queryImage(path, { limit: 40 }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="view" style={{ maxWidth: 860 }}>
      <h1 className="view-title">文件搜索</h1>
      <p className="view-sub">以文搜文（语义）· 以文搜图 · 以图搜图 —— 语义检索需在设置中就绪本地模型</p>

      {/* 模式切换 */}
      <div className="seg" style={{ display: 'inline-flex', marginBottom: 16 }}>
        <button type="button" className={mode === 'all' ? 'on' : ''} onClick={() => setMode('all')}>
          全部内容
        </button>
        <button type="button" className={mode === 'images' ? 'on' : ''} onClick={() => setMode('images')}>
          搜图片
        </button>
        <button type="button" className={mode === 'byImage' ? 'on' : ''} onClick={() => setMode('byImage')}>
          以图搜图
        </button>
      </div>

      {/* 输入区 */}
      {mode === 'byImage' ? (
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
          <p>{imagePath ? `已选：${imagePath.split('/').pop()}` : '拖拽图片到这里，或点击选择'}</p>
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
          {imagePath ? (
            <button
              type="button"
              className="btn primary small"
              style={{ marginTop: 8 }}
              onClick={(e) => {
                e.stopPropagation()
                setResults([])
                setSearched(false)
              }}
            >
              重新选择
            </button>
          ) : null}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          <input
            className="settings-input"
            style={{ flex: 1, padding: '9px 12px', fontSize: 14 }}
            placeholder={mode === 'images' ? '描述图片内容，如：橙色封面设计…' : '语义搜索所有内容：文档、图片、收藏、订阅…'}
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
        <div className="search-results-list">
          <div style={{ fontSize: 13, color: 'var(--fg-faint)', marginBottom: 10 }}>
            {busy ? '检索中…' : `${results.length} 条结果`}
          </div>
          {results.map((r: SearchResult) => (
            <button
              key={r.id}
              type="button"
              className="search-result-item"
              onClick={() => r.sourcePath && window.oasis.files.reveal(r.sourcePath)}
            >
              <Icon name={r.type === 'image' ? 'image' : 'doc'} size={15} />
              <div className="search-result-body">
                <span className="search-result-title">{r.title}</span>
                {r.snippet ? <span className="search-result-snippet">{r.snippet}</span> : null}
              </div>
              <span className="search-result-score">{(r.score * 100).toFixed(0)}%</span>
            </button>
          ))}
          {!busy && results.length === 0 ? (
            <div className="search-results-empty">
              <Icon name="search" size={28} />
              <p>没有找到相关内容</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
