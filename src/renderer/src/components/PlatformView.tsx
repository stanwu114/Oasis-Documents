import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { useUiStore } from '../stores/uiStore'
import { toMediaUrl } from '../lib/media'
import { MasonryGrid } from './MasonryGrid'
import { platformLabel } from '../../../shared/platform'

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

function fmtDate(ts: number): string {
  const d = new Date(ts)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

export function PlatformView(): React.ReactNode {
  const importLock = useRef(false)
  const [url, setUrl] = useState('')
  const [importError, setImportError] = useState('')
  const [progress, setProgress] = useState('正在解析帖子…')
  const contentsVersion = useUiStore((s) => s.contentsVersion)
  const [importing, setImporting] = useState(false)
  const [retagging, setRetagging] = useState(false)
  const [rows, setRows] = useState<PlatformRow[]>([])
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const collectionPlatform = useUiStore((s) => s.collectionPlatform)

  useEffect(() => {
    void load()
  }, [contentsVersion])
  useEffect(() => window.oasis.platform.onProgress((p) => {
    setProgress(p.message ?? (p.phase === 'parsing' ? '正在解析帖子…' : p.phase === 'saving' ? '正在保存本地内容…' : `正在下载图片和视频 ${p.completed ?? 0} / ${p.total ?? 0}`))
  }), [])

  const load = async (): Promise<void> => {
    setRows(await window.oasis.platform.listContents())
  }

  const onImport = async (value = url): Promise<void> => {
    const u = value.trim()
    if (!u || importLock.current) return
    importLock.current = true
    setImportError('')
    setProgress('正在解析帖子…')
    setImporting(true)
    try {
      const r = await window.oasis.platform.importLink(u)
      if (r.warnings.length) {
        setImportError(`正文已保存，媒体下载未完成：${r.warnings.join('；')}`)
        useUiStore.getState().showToast(`正文已保存，部分媒体未下载：${r.warnings[0]}，可在详情中重试。`, 'error')
      } else if (r.images > 0 || r.video) {
        useUiStore.getState().showToast(
          `${r.created ? '已导入' : '已更新'}「${r.title}」· ${r.images} 张图${r.video ? ' · 含视频' : ''}`
        )
      } else {
        /* 空图文可见化:给出可执行的下一步,而不是静默成功 */
        useUiStore.getState().showToast(
          `已保存「${r.title}」,未下载到图片或视频。请确认原帖公开可访问，重新复制完整分享链接后再试`,
          'error'
        )
      }
      setUrl('')
      useUiStore.getState().bumpContents()
      await load()
    } catch (e) {
      const message = `导入失败：${e instanceof Error ? e.message : e}`
      setImportError(message)
      useUiStore.getState().showToast(message, 'error')
    } finally {
      importLock.current = false
      setImporting(false)
    }
  }

  /* 删除收藏:行/笔记/FTS/向量/缩略图级联清理 */
  const onRemove = async (id: string, title: string): Promise<void> => {
    const ok = window.confirm(`删除收藏「${title.slice(0, 40)}」？\n\n正文、标签、笔记与本地缩略图将一起删除，不可恢复。`)
    if (!ok) return
    try {
      const r = await window.oasis.platform.remove(id)
      if (r.removed) {
        useUiStore.getState().showToast('已删除')
        await load()
        useUiStore.getState().bumpContents() /* 侧栏平台分组计数同步刷新 */
      }
    } catch (e) {
      useUiStore.getState().showToast(`删除失败：${e instanceof Error ? e.message : e}`, 'error')
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

  /* 平台过滤(侧栏"我的收藏"二级目录) + 标签过滤 */
  const platformFiltered = collectionPlatform ? rows.filter((r) => r.platform === collectionPlatform) : rows
  const tagCloud = [...new Set(platformFiltered.flatMap((r) => r.tags))].slice(0, 30)
  const filtered = activeTag ? platformFiltered.filter((r) => r.tags.includes(activeTag)) : platformFiltered

  return (
    <div className="platform-view">
      <div className="platform-head">
        <div>
          <h1 className="view-title">
            {collectionPlatform ? `我的收藏 · ${platformLabel(collectionPlatform)}` : '我的收藏'}
          </h1>
          <p className="view-sub" style={{ marginBottom: 0 }}>
            粘贴小红书 / 抖音 / 微信 / CSDN 分享链接 · 图文和视频保存到本地
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          {collectionPlatform ? (
            <button type="button" className="btn ghost" onClick={() => useUiStore.getState().openCollection(null)}>
              ← 全部平台
            </button>
          ) : null}
          <button type="button" className="btn ghost" onClick={() => void onRetag()} disabled={retagging || rows.length === 0}>
            {retagging ? '打标中…' : '重新 AI 打标'}
          </button>
        </div>
      </div>

      <div className="platform-import-bar">
        <textarea
          rows={3}
          disabled={importing}
          className="settings-input"
          style={{ flex: 1 }}
          placeholder="粘贴完整分享文案后自动导入，支持抖音 / 小红书 / 公众号 / CSDN"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text')
            if (!/https?:\/\//i.test(text) || importLock.current) return
            e.preventDefault()
            setUrl(text)
            void onImport(text)
          }}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void onImport() } }}
        />
        <button type="button" className="btn primary" onClick={() => void onImport()} disabled={importing}>
          {importing ? '导入中…' : '导入'}
        </button>
      </div>

      {importing ? <p role="status" className="view-sub">{progress} · 下载超时会提示，失败后可重试</p> : null}

      {importError ? <p role="alert" style={{ color: 'var(--danger)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{importError}</p> : null}

      {tagCloud.length > 0 ? (
        <div className="platform-tagcloud">
          <button
            type="button"
            className={`tag-chip${activeTag === null ? ' on' : ''}`}
            onClick={() => setActiveTag(null)}
          >
            全部 {platformFiltered.length}
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
            /* 本地缩略图优先;缺失时回退收藏时抓到的原图列表第一张 */
            const cover = r.thumbnail_path ? toMediaUrl(r.thumbnail_path) : (r.image_urls[0] ? (/^https?:/.test(r.image_urls[0]) ? r.image_urls[0] : toMediaUrl(r.image_urls[0])) : undefined)
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
                <div className={`note-card-cover ${cover ? '' : 'placeholder'}`}>
                  {cover ? (
                    <img
                      src={cover}
                      alt={r.title}
                      loading="lazy"
                      data-mkey={r.id}
                      onLoad={(e) => onImageLoad(e.currentTarget)}
                    />
                  ) : (
                    <span className="note-card-cover-platform">
                      <Icon name="doc" size={26} />
                      <em>{platformLabel(r.platform)}</em>
                    </span>
                  )}
                  <span className="note-card-badge">{platformLabel(r.platform)}</span>
                </div>
                <button
                  type="button"
                  className="note-card-del"
                  title="删除这条收藏"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    void onRemove(r.id, r.title)
                  }}
                >
                  ✕
                </button>
                <div className="note-card-body">
                  <span className="note-card-title">{r.title}</span>
                  {r.snippet ? <span className="note-card-desc">{r.snippet}</span> : null}
                  <div className="note-card-tags">
                    <span className="note-tag-src" title="来源平台">{platformLabel(r.platform)}</span>
                    {r.tags.slice(0, 4).map((t) => (
                      <span key={t} className="note-tag">#{t}</span>
                    ))}
                  </div>
                  <span className="note-card-meta">{fmtDate(r.created_at)}</span>
                </div>
              </a>
            )
          }}
        />
      ) : (
        <div className="search-results-empty">
          <Icon name="doc" size={28} />
          <p>{rows.length === 0 ? '还没有收藏，粘贴链接开始导入' : '该平台/标签下暂无内容'}</p>
        </div>
      )}
    </div>
  )
}
