import { useEffect, useState } from 'react'
import { Icon } from './Icon'
import type { SystemStatus } from '../../../shared/ipc'

/* ================================================================
   系统状态页:导入/向量化总量与待处理、失败明细、各模型使用状态
   数据来自主进程 status:overview(轮询 5s,进行中任务实时变化)
   ================================================================ */

function StatCard({ label, value, accent }: { label: string; value: number; accent?: boolean }): React.ReactNode {
  return (
    <div className={`stat-card${accent ? ' accent' : ''}`}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  )
}

function FailTable({ title, rows, emptyText }: { title: string; rows: { name: string; reason: string }[]; emptyText: string }): React.ReactNode {
  return (
    <div className="status-fails">
      <div className="report-head">{title}（{rows.length}）</div>
      {rows.length === 0 ? (
        <p className="status-fail-empty">{emptyText}</p>
      ) : (
        <div className="status-fail-list">
          {rows.map((r, i) => (
            <div key={i} className="report-fail-row" title={r.name}>
              <span className="status-fail-name">· {r.name.length > 60 ? `${r.name.slice(0, 60)}…` : r.name}</span>
              <span className="status-fail-reason" title={r.reason}>{r.reason}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function StatusView(): React.ReactNode {
  const [st, setSt] = useState<SystemStatus | null>(null)

  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      const s = await window.oasis.status.overview()
      if (alive) setSt(s)
    }
    void load()
    const timer = window.setInterval(() => void load(), 5000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  if (!st) {
    return (
      <div className="view" style={{ maxWidth: 940 }}>
        <h1 className="view-title">系统状态</h1>
        <p className="view-sub">载入中…</p>
      </div>
    )
  }

  const modelRows: { label: string; value: string }[] = [
    { label: '文本向量模型（本地/在线）', value: st.models.textEmbedding },
    { label: '图片向量模型（本地/在线）', value: st.models.imageEmbedding },
    { label: '文本模型（在线）', value: st.models.textLlm },
    { label: '多模态模型（在线）', value: st.models.multimodal },
    { label: '音频模型（在线）', value: st.models.audio }
  ]

  return (
    <div className="view" style={{ maxWidth: 940 }}>
      <h1 className="view-title">系统状态</h1>
      <p className="view-sub">导入与向量化的总量、待处理与失败明细 · 5 秒自动刷新</p>

      {/* 总量卡片 */}
      <div className="stat-grid">
        <StatCard label="本地文件已导入" value={st.importedFiles} />
        <StatCard label="待导入" value={st.pendingImport} accent={st.pendingImport > 0} />
        <StatCard label="已向量化" value={st.embedded} />
        <StatCard label="待向量化" value={st.pendingEmbed} accent={st.pendingEmbed > 0} />
      </div>

      {/* 失败明细 */}
      <FailTable title="导入失败" rows={st.importFails} emptyText="没有导入失败的文件" />
      <FailTable title="向量化失败" rows={st.embedFails} emptyText="没有向量化失败的内容" />

      {/* 模型使用状态 */}
      <section className="settings-section" style={{ marginTop: 22 }}>
        <h3>模型使用状态</h3>
        {modelRows.map((m) => (
          <div key={m.label} className="settings-row">
            <span>{m.label}</span>
            <span className="settings-value">{m.value}</span>
          </div>
        ))}
        {st.pendingEmbed > 0 ? (
          <p style={{ color: 'var(--fg-faint)', fontSize: 12, marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icon name="gauge" size={12} /> 待向量化内容会在后台自动补处理,无需干预
          </p>
        ) : null}
      </section>
    </div>
  )
}
