import { useEffect, useState } from 'react'
import { Icon } from './Icon'
import { toMediaUrl } from '../lib/media'
import { useUiStore } from '../stores/uiStore'
import { CATEGORY_LABEL, MASONRY_CATEGORIES, type FileCategory } from '../../../shared/classify'
import type { FileListRow } from '../../../shared/ipc'

/* R27：行类型来自共享 DTO（FileListRow），category 语义化为 FileCategory */
type ContentRow = Omit<FileListRow, 'category'> & { category: FileCategory }

type Tab = 'all' | FileCategory

const CAT_ICON: Record<string, string> = {
  image: 'image', video: 'doc', drawing: 'doc', audio: 'doc', document: 'doc', other: 'file'
}

/* 具体格式名（列表徽标显示），未映射的显示扩展名大写 */
const FORMAT_LABEL: Record<string, string> = {
  pdf: 'PDF', doc: 'DOC', docx: 'DOCX', wps: 'WPS',
  txt: 'TXT', md: 'MD', markdown: 'MD', rtf: 'RTF', log: 'LOG', epub: 'EPUB',
  xls: 'XLS', xlsx: 'XLSX', et: 'ET', csv: 'CSV', tsv: 'TSV',
  ppt: 'PPT', pptx: 'PPTX', dps: 'DPS', key: 'KEY',
  json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', xml: 'XML',
  html: 'HTML', htm: 'HTML', css: 'CSS',
  ts: 'TS', tsx: 'TSX', js: 'JS', jsx: 'JSX', py: 'PY', go: 'GO', rs: 'RS',
  java: 'JAVA', swift: 'SWIFT', sh: 'SH', sql: 'SQL', c: 'C', h: 'H', cpp: 'CPP',
  mp3: 'MP3', wav: 'WAV', aac: 'AAC', flac: 'FLAC', m4a: 'M4A', aiff: 'AIFF', ogg: 'OGG',
  mp4: 'MP4', mov: 'MOV', mkv: 'MKV', avi: 'AVI', webm: 'WEBM', flv: 'FLV',
  dwg: 'DWG', dxf: 'DXF', skp: 'SKP', rvt: 'RVT', stl: 'STL', obj: 'OBJ',
  svg: 'SVG', psd: 'PSD', ai: 'AI', eps: 'EPS',
  jpg: 'JPG', jpeg: 'JPEG', png: 'PNG', webp: 'WEBP', gif: 'GIF', heic: 'HEIC', tiff: 'TIFF', bmp: 'BMP'
}

function formatLabel(ext: string): string {
  return FORMAT_LABEL[ext] ?? (ext || 'FILE').toUpperCase()
}

function fmtBytes(bytes: number | null): string {
  if (!bytes) return ''
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

export function FilesView(): React.ReactNode {
  const currentDir = useUiStore((s) => s.currentDir)
  const contentsVersion = useUiStore((s) => s.contentsVersion)
  const [rows, setRows] = useState<ContentRow[]>([])
  const [total, setTotal] = useState(0)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState<Tab>('all')

  const PAGE = 500

  const load = async (mode: 'reset' | 'more'): Promise<void> => {
    setLoading(true)
    try {
      const res = await window.oasis.files.list(undefined, {
        offset: mode === 'more' ? rows.length : 0,
        limit: PAGE,
        dir: currentDir ?? undefined,
        category: tab === 'all' ? undefined : tab
      })
      const mapped = res.rows as ContentRow[]
      setRows(mode === 'more' ? [...rows, ...mapped] : mapped)
      setTotal(res.total)
      setHasMore(res.hasMore)
      setCounts(res.counts)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load('reset')
    /* contentsVersion 变化或目录/分类切换时按新范围重拉 */
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [contentsVersion, currentDir, tab])

  /* R22：过滤已由后端完成，前端直接展示；计数来自后端同源统计 */
  const visible = rows
  const dirName = currentDir ? currentDir.split('/').pop() : null
  const useMasonry = MASONRY_CATEGORIES.includes(tab as FileCategory)

  return (
    <div className="view" style={{ maxWidth: 940 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h1 className="view-title" style={{ margin: 0 }}>{dirName ?? '我的文件'}</h1>
        {currentDir ? (
          <button
            type="button"
            className="btn small ghost"
            style={{ marginTop: 6 }}
            onClick={() => useUiStore.getState().openDir(null)}
          >
            ← 全部
          </button>
        ) : null}
      </div>
      <p className="view-sub">
        {currentDir ? `当前目录：${currentDir}` : '图片 / 视频 / 图纸按瀑布流展示，音频 / 文档 / 其他按列表展示。'}
      </p>

      {/* 六分类标签 */}
      <div className="seg" style={{ marginBottom: 20, display: 'inline-flex', flexWrap: 'wrap' }}>
        <button type="button" className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>
          全部 {total}
        </button>
        {(Object.keys(CATEGORY_LABEL) as FileCategory[]).map((c) => (
          <button key={c} type="button" className={tab === c ? 'on' : ''} onClick={() => setTab(c)}>
            {CATEGORY_LABEL[c]} {counts[c] ?? 0}
          </button>
        ))}
      </div>

      {/* 瀑布流（图片/视频/图纸） */}
      {useMasonry && visible.length > 0 ? (
        <div className="masonry">
          {visible.map((r) => (
            <button
              key={r.id}
              type="button"
              className="note-card"
              onClick={() => useUiStore.getState().openDetail(r.id)}
              title={r.full_name}
            >
              <div className={`note-card-cover ${r.thumbnail_path ? '' : 'placeholder'}`}>
                {r.thumbnail_path ? (
                  <img src={toMediaUrl(r.thumbnail_path) ?? undefined} alt={r.title} loading="lazy" />
                ) : (
                  <span className="note-card-cover-platform">
                    <Icon name={CAT_ICON[r.category] ?? 'doc'} size={24} />
                    <em>{(r.ext || r.category).toUpperCase()}</em>
                  </span>
                )}
                {r.category === 'video' ? <span className="video-play-mark">▶</span> : null}
              </div>
              <div className="note-card-body">
                <span className="note-card-title">{r.full_name}</span>
                <span className="note-card-meta">{fmtTime(r.modified_at)}{r.file_size ? ` · ${fmtBytes(r.file_size)}` : ''}</span>
              </div>
            </button>
          ))}
        </div>
      ) : null}

      {/* 列表（全部 / 音频 / 文档 / 其他） */}
      {!useMasonry && visible.length > 0 ? (
        <div className="doc-list">
          {visible.map((r) => (
            <div key={r.id} className="doc-row">
              <Icon name={r.thumbnail_path ? 'image' : (CAT_ICON[r.category] ?? 'doc')} size={16} />
              {r.thumbnail_path ? (
                <img
                  src={toMediaUrl(r.thumbnail_path) ?? undefined}
                  alt=""
                  className="doc-thumb"
                  loading="lazy"
                />
              ) : null}
              <span className="doc-name" title={r.source_path ?? r.full_name}>{r.full_name}</span>
              <span className="doc-fmt">{formatLabel(r.ext)}</span>
              <span className="doc-size">{fmtBytes(r.file_size)}</span>
              <span className="doc-time">{fmtTime(r.modified_at)}</span>
              {r.source_path ? (
                <button
                  type="button"
                  className="doc-reveal-link"
                  onClick={() => useUiStore.getState().openDetail(r.id)}
                >
                  <Icon name="folder" size={12} /> 打开位置
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {visible.length === 0 ? (
        <div className="search-results-empty">
          <Icon name="files" size={28} />
          <p>{rows.length === 0 ? '暂无内容，导入文件夹后自动入库' : '该分类下暂无文件'}</p>
        </div>
      ) : null}

      {/* 分页加载 */}
      {hasMore ? (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 20 }}>
          <button type="button" className="btn ghost" onClick={() => void load('more')} disabled={loading}>
            {loading ? '加载中…' : `加载更多（已显示 ${rows.length} / 共 ${total} 条）`}
          </button>
        </div>
      ) : null}
    </div>
  )
}
