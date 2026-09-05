import { useEffect, useState } from 'react'
import { Icon } from './Icon'
import { useUiStore } from '../stores/uiStore'
import { toMediaUrl } from '../lib/media'
import type { ContentDetail, NoteRow } from '../../../shared/ipc'

/* ================================================================
   F01 文件详情 + F03 纯净阅读（统一模态）
   - 图片：原图预览 + 尺寸/EXIF/OCR 文本
   - 文档/收藏/订阅：正文渲染 + 划线高亮 + 笔记
   ================================================================ */

export function DetailModal(): React.ReactNode {
  const detailId = useUiStore((s) => s.detailId)
  const close = (): void => useUiStore.getState().openDetail(null)

  const [data, setData] = useState<ContentDetail | null>(null)
  const [notes, setNotes] = useState<NoteRow[]>([])
  const [sel, setSel] = useState<string>('')

  useEffect(() => {
    if (!detailId) return
    setData(null)
    setNotes([])
    void (async () => {
      const d =
        (await window.oasis.files.getReading(detailId)) ?? (await window.oasis.files.getDetail(detailId))
      setData(d as unknown as ContentDetail)
      if (d) setNotes(await window.oasis.notes.list(d.id))
    })()
  }, [detailId])

  if (!detailId) return null

  const isImage = data?.type === 'image'
  const meta = (data?.meta ?? {}) as Record<string, unknown>
  const exif = meta.exif as Record<string, unknown> | undefined

  const addNote = async (): Promise<void> => {
    if (!data || !sel.trim()) return
    await window.oasis.notes.add(data.id, sel.trim(), '')
    setNotes(await window.oasis.notes.list(data.id))
    setSel('')
  }

  return (
    <div className="modal-overlay" onClick={close}>
      <div className="detail-card" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="detail-close" onClick={close}>
          <Icon name="close" size={14} />
        </button>

        {!data ? (
          <div className="detail-loading">载入中…</div>
        ) : (
          <>
            <div className="detail-title">{data.title || '未命名'}</div>
            <div className="detail-meta-row">
              {data.platform ? <span className="detail-chip">{data.platform}</span> : null}
              {data.mime_type && !isImage ? <span className="detail-chip">{data.ext?.toUpperCase?.() ?? ''}</span> : null}
              <span className="detail-time">{new Date(data.created_at).toLocaleString('zh-CN')}</span>
              <span className="detail-actions">
                {data.source_path ? (
                  <button type="button" className="link-btn" onClick={() => window.oasis.files.reveal(data.source_path as string)}>
                    打开位置
                  </button>
                ) : null}
                {data.url ? (
                  <button type="button" className="link-btn" onClick={() => void window.open(data.url as string, '_blank')}>
                    打开原文
                  </button>
                ) : null}
              </span>
            </div>

            {isImage ? (
              <div className="detail-body">
                <div className="detail-image-wrap">
                  <img src={toMediaUrl(data.source_path) ?? toMediaUrl(data.thumbnail_path) ?? undefined} alt={data.title} />
                </div>
                {exif ? (
                  <div className="detail-exif">
                    {exif.DateTimeOriginal ? <span>拍摄时间：{String(exif.DateTimeOriginal).slice(0, 19)}</span> : null}
                    {exif.Make ? <span>设备：{String(exif.Make)} {String(exif.Model ?? '')}</span> : null}
                    {meta.width ? <span>尺寸：{String(meta.width)}×{String(meta.height)}</span> : null}
                  </div>
                ) : null}
                {data.ocr_text ? (
                  <div className="detail-ocr">
                    <div className="detail-section-head">OCR 识别文字</div>
                    <pre>{data.ocr_text.slice(0, 3000)}</pre>
                  </div>
                ) : meta.extractStatus ? (
                  <div className="detail-hint">
                    {meta.extractStatus === 'unsupported-fulltext' ? '该格式暂不支持全文提取' : '该文件无法提取内容'}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="detail-body">
                <div
                  className="reading-body"
                  onMouseUp={() => setSel(window.getSelection()?.toString() ?? '')}
                >
                  {renderBody(data.content || data.title)}
                  {/* 高亮已有划线 */}
                </div>
                {sel ? (
                  <div className="reading-selbar">
                    <span className="reading-seltext">「{sel.slice(0, 60)}{sel.length > 60 ? '…' : ''}」</span>
                    <button type="button" className="btn small primary" onClick={() => void addNote()}>
                      划线收藏
                    </button>
                  </div>
                ) : null}
                {notes.length > 0 ? (
                  <div className="reading-notes">
                    <div className="detail-section-head">笔记与划线（{notes.length}）</div>
                    {notes.map((n) => (
                      <div key={n.id} className="reading-note-item">
                        <div className="reading-note-anchor">「{n.anchor_text.slice(0, 80)}」</div>
                        <textarea
                          className="reading-note-input"
                          defaultValue={n.note}
                          placeholder="写点想法…"
                          onBlur={async (e) => {
                            if (e.target.value !== n.note) {
                              await window.oasis.notes.update(n.id, e.target.value)
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="btn small danger-ghost"
                          onClick={async () => {
                            await window.oasis.notes.remove(n.id)
                            setNotes(await window.oasis.notes.list(data.id))
                          }}
                        >
                          删除
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** 正文渲染：纯文本段落化（受控，不注入 HTML） */
function renderBody(text: string): React.ReactNode {
  if (!text) return <p className="reading-empty">暂无正文内容</p>
  const paras = text.split(/\n{2,}/).filter((p) => p.trim())
  return paras.slice(0, 300).map((p, i) => <p key={i}>{p}</p>)
}
