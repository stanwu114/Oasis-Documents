import { useEffect, useRef } from 'react'
import { useUiStore } from '../stores/uiStore'
import type { FailReason, ImportProgress } from '../../../shared/ipc'

/** 导入进度弹窗：事件推送 + 3 秒轮询双通道，UI 收敛不依赖单点 */
export function ImportModal(): React.ReactNode {
  const lastSession = useRef(-1)
  /* 已展示完成报告的会话：同一会话只弹一次（用户关闭后轮询不重弹） */
  const reportedSession = useRef(-1)

  const applyState = (s: ImportProgress): void => {
    if (s.phase === 'indexing' && s.sessionId !== lastSession.current) {
      lastSession.current = s.sessionId
      useUiStore.getState().setImportModalHidden(false)
      useUiStore.getState().setImportDoneReport(null) /* 新会话清掉旧报告 */
    }
    if (s.phase === 'done') {
      if (reportedSession.current !== s.sessionId) {
        reportedSession.current = s.sessionId
        useUiStore.getState().bumpContents()
        useUiStore.getState().setImportDoneReport(s)
      }
      useUiStore.getState().setImportProgress(null)
    } else {
      useUiStore.getState().setImportProgress(s)
    }
  }

  useEffect(() => {
    /* 通道 1：主进程事件推送 */
    const off = window.oasis.on.importProgress(applyState)

    /* 通道 2：3 秒轮询兜底（推送丢失/渲染层错过事件时仍必然收敛） */
    const poll = window.setInterval(() => {
      void window.oasis.importStatus().then((s) => {
        if (s.phase === 'idle') return
        const cur = useUiStore.getState().importProgress
        const rep = useUiStore.getState().importDoneReport
        /* 报告已显示或进度更新鲜则跳过 */
        if (rep) return
        if (cur && s.percent <= cur.percent && s.phase === cur.phase) return
        applyState(s)
      })
    }, 3000)

    return () => {
      off()
      window.clearInterval(poll)
    }
  }, [])

  const p = useUiStore((s) => s.importProgress)
  const hidden = useUiStore((s) => s.importModalHidden)
  const report = useUiStore((s) => s.importDoneReport)

  /* 完成报告优先显示（不自动消失，用户看清楚后手动关） */
  if (report) return <DoneReport p={report} />
  if (!p || p.phase === 'idle' || hidden) return null

  const phaseText =
    p.phase === 'indexing'
      ? `正在导入 ${p.done} / ${p.total} 个文件`
      : `正在向量化 ${p.embedDone} / ${p.embedTotal} · 建立语义索引`

  const subText =
    p.phase === 'indexing' ? '提取缩略图、全文与分类' : 'CLIP 处理图片 · BGE 处理文档'

  return (
    <div className="modal-overlay">
      <div className="import-card">
        <div className="import-title">正在导入文件夹</div>
        <div className="progress-track" style={{ height: 8, margin: '14px 0 10px' }}>
          <div className="progress-bar" style={{ width: `${p.percent}%` }} />
        </div>
        <div className="import-row">
          <span className="import-phase">{phaseText}</span>
          <span className="import-percent">{p.percent}%</span>
        </div>
        <div className="import-sub">{subText}</div>
        <button
          type="button"
          className="btn primary import-hide"
          onClick={() => useUiStore.getState().setImportModalHidden(true)}
        >
          后台继续
        </button>
      </div>
    </div>
  )
}

/** 完成报告：总数/新增/跳过/失败 + 向量化统计 + 失败原因聚合 */
function DoneReport({ p }: { p: ImportProgress }): React.ReactNode {
  const total = p.indexed + p.skipped + p.indexFailed
  const close = (): void => useUiStore.getState().setImportDoneReport(null)

  return (
    <div className="modal-overlay">
      <div className="import-card" style={{ width: 460 }}>
        <div className="import-title">✓ 导入完成</div>

        <div className="report-section">
          <div className="report-head">导入</div>
          <div className="report-line">
            共 <b>{total}</b> 个文件 · 新增 <b className="c-ok">{p.indexed}</b> · 跳过（已存在）{' '}
            <b>{p.skipped}</b> · 失败 <b className={p.indexFailed > 0 ? 'c-bad' : ''}>{p.indexFailed}</b>
          </div>
          <FailList reasons={p.indexFailReasons} />
        </div>

        {p.embedTotal > 0 ? (
          <div className="report-section">
            <div className="report-head">向量化</div>
            <div className="report-line">
              共 <b>{p.embedTotal}</b> 个 · 成功 <b className="c-ok">{p.embedded}</b> · 失败{' '}
              <b className={p.embedFailed > 0 ? 'c-bad' : ''}>{p.embedFailed}</b>
            </div>
            <FailList reasons={p.embedFailReasons} />
          </div>
        ) : null}

        <button type="button" className="btn primary import-hide" onClick={close}>
          完成
        </button>
      </div>
    </div>
  )
}

function FailList({ reasons }: { reasons: FailReason[] }): React.ReactNode {
  if (reasons.length === 0) return null
  return (
    <div className="report-fails">
      {reasons.map((r) => (
        <div key={r.reason} className="report-fail-row">
          <span>· {r.reason}</span>
          <span className="report-fail-count">×{r.count}</span>
        </div>
      ))}
    </div>
  )
}
