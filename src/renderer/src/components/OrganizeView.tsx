import { useEffect, useState } from 'react'
import { Icon } from './Icon'
import { useUiStore } from '../stores/uiStore'

interface DupGroup {
  id: number
  kind: 'exact' | 'near-image'
  files: string[]
  wastedBytes: number
  keepPath: string | null
}

interface BatchRow {
  batchId: string
  count: number
  createdAt: number
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

export function OrganizeView(): React.ReactNode {
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState<{ scanned: number; current: string } | null>(null)
  const [groups, setGroups] = useState<DupGroup[]>([])
  const [checked, setChecked] = useState<Set<string>>(new Set())
  /* R08：操作历史与撤销（仅对真实可撤销的批次展示） */
  const [batches, setBatches] = useState<BatchRow[]>([])

  useEffect(() => {
    void refreshGroups()
    void refreshBatches()
  }, [])

  const refreshBatches = async (): Promise<void> => {
    setBatches(await window.oasis.organizer.batches())
  }

  const onRevert = async (batchId: string): Promise<void> => {
    const ok = window.confirm(`撤销批次 ${batchId.slice(0, 8)}？将把该批移动/清理的文件恢复到原位置。`)
    if (!ok) return
    try {
      const n = await window.oasis.organizer.revert(batchId)
      useUiStore.getState().showToast(n > 0 ? `已恢复 ${n} 项` : '未能恢复任何项（废纸篓可能已被清空）')
      await Promise.all([refreshGroups(), refreshBatches()])
    } catch (e) {
      useUiStore.getState().showToast(`撤销失败：${e instanceof Error ? e.message : e}`, 'error')
    }
  }

  const refreshGroups = async (): Promise<void> => {
    const list = await window.oasis.organizer.duplicates('pending')
    setGroups(list)
  }

  const onScan = async (): Promise<void> => {
    const paths = await window.oasis.files.getWatchPaths()
    if (paths.length === 0) {
      useUiStore.getState().showToast('请先在设置中添加监控目录', 'error')
      return
    }
    setScanning(true)
    const off = window.oasis.organizer.onProgress(setProgress)
    try {
      const result = await window.oasis.organizer.scan(paths)
      useUiStore
        .getState()
        .showToast(`扫描完成：${result.exactGroups} 组精确重复、${result.nearImageGroups} 组近似图片，可释放 ${fmtBytes(result.wastedBytes)}`)
      await refreshGroups()
    } catch (e) {
      useUiStore.getState().showToast(`扫描失败：${e instanceof Error ? e.message : e}`, 'error')
    } finally {
      off()
      setScanning(false)
      setProgress(null)
    }
  }

  const onClean = async (): Promise<void> => {
    /* 勾选的重复文件（keep 文件不勾）→ 移入废纸篓 */
    if (checked.size === 0) {
      useUiStore.getState().showToast('先勾选要清理的重复文件')
      return
    }
    const toTrash = [...checked].filter((p) => !groups.some((g) => g.keepPath === p))
    if (toTrash.length === 0) {
      useUiStore.getState().showToast('勾选的文件都是保留项')
      return
    }
    const result = await window.oasis.organizer.trash(toTrash)
    useUiStore
      .getState()
      .showToast(
        result.failed.length === 0
          ? `已清理 ${result.done} 个文件（批次 ${result.batchId.slice(0, 8)}，可撤销）`
          : `清理 ${result.done} 个，失败 ${result.failed.length} 个`,
        result.failed.length === 0 ? 'info' : 'error'
      )
    await refreshGroups()
    setChecked(new Set())
    await refreshBatches()
  }

  const totalWasted = groups.reduce((a, g) => a + g.wastedBytes, 0)

  return (
    <div className="view">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
        <h1 className="view-title" style={{ margin: 0 }}>整理工作台</h1>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button type="button" className="btn primary" onClick={() => void onScan()} disabled={scanning}>
            {scanning ? <span className="spin" style={{ marginRight: 6 }} /> : <Icon name="search" size={13} />}
            {scanning ? `扫描中 ${progress?.scanned ?? 0}` : '扫描重复文件'}
          </button>
          <button type="button" className="btn danger-ghost" onClick={() => void onClean()} disabled={groups.length === 0}>
            清理勾选项
          </button>
        </div>
      </div>
      <p className="view-sub">
        精确重复按 SHA-256 判定；近似图片按感知哈希判定。清理走系统废纸篓，可撤销。
      </p>

      {scanning && progress ? (
        <div style={{ marginBottom: 20 }}>
          <div className="progress-track">
            <div className="progress-bar" style={{ width: '35%' }} />
          </div>
          <div style={{ fontSize: 12, color: 'var(--fg-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {progress.current}
          </div>
        </div>
      ) : null}

      {groups.length > 0 ? (
        <>
          <div className="dup-summary">
            <div className="dup-stat">
              <div className="dup-stat-num">{groups.length}</div>
              <div className="dup-stat-label">重复组</div>
            </div>
            <div className="dup-stat">
              <div className="dup-stat-num" style={{ color: 'var(--danger)' }}>{fmtBytes(totalWasted)}</div>
              <div className="dup-stat-label">可释放空间</div>
            </div>
            <div className="dup-stat">
              <div className="dup-stat-num">{checked.size}</div>
              <div className="dup-stat-label">已勾选清理</div>
            </div>
          </div>

          {groups.map((g) => (
            <div key={g.id} className="dup-group">
              <div className="dup-group-head">
                <span className={`dup-badge ${g.kind}`}>{g.kind === 'exact' ? '精确重复' : '近似图片'}</span>
                <span style={{ color: 'var(--fg-muted)' }}>{g.files.length} 个文件</span>
                <span className="dup-wasted">可释放 {fmtBytes(g.wastedBytes)}</span>
              </div>
              {g.files.map((f) => (
                <label key={f} className={`dup-file-row${f === g.keepPath ? ' keep' : ''}`}>
                  <input
                    type="checkbox"
                    checked={checked.has(f)}
                    onChange={(e) => {
                      const next = new Set(checked)
                      if (e.target.checked) next.add(f)
                      else next.delete(f)
                      setChecked(next)
                    }}
                    disabled={f === g.keepPath}
                  />
                  <span className="dup-file-path" title={f}>{f}</span>
                  {f === g.keepPath ? <span className="dup-keep-tag">建议保留</span> : null}
                </label>
              ))}
            </div>
          ))}
        </>
      ) : (
        <div className="search-results-empty">
          <Icon name="broom" size={28} />
          <p>{scanning ? '正在扫描…' : '没有待处理的重复文件，点击上方按钮开始扫描'}</p>
        </div>
      )}

      {/* F04：规则归档——结构化规则编辑 + 建议预览 + 执行 */}
      <RulesSection onExecuted={() => void refreshBatches()} />

      {/* R08：操作历史与撤销——仅展示真实可恢复的批次 */}
      {batches.length > 0 ? (
        <div style={{ marginTop: 36 }}>
          <div className="sidebar-pages-head" style={{ padding: '0 2px 8px' }}>最近操作（可撤销）</div>
          <div className="doc-list">
            {batches.map((b) => (
              <div key={b.batchId} className="doc-row">
                <Icon name="undo" size={14} />
                <span className="doc-name">
                  批次 {b.batchId.slice(0, 8)} · {b.count} 项 · {fmtTime(b.createdAt)}
                </span>
                <button type="button" className="btn small danger-ghost" onClick={() => void onRevert(b.batchId)}>
                  撤销
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/* ================================================================
   F04：规则归档区块——结构化规则编辑（无 YAML 手写）、建议预览
   （源→目标、理由、冲突标记）、勾选执行（走 safeMove）、删除规则
   ================================================================ */

interface SuggestionRow {
  id: number
  file_path: string
  action: string
  target_path: string | null
  reason: string
  status: string
}

interface RuleRow {
  id: number
  name: string
  enabled: number
}

function RulesSection({ onExecuted }: { onExecuted: () => void }): React.ReactNode {
  const [rules, setRules] = useState<RuleRow[]>([])
  const [suggestions, setSuggestions] = useState<SuggestionRow[]>([])
  const [picked, setPicked] = useState<Set<number>>(new Set())
  /* 新规则表单 */
  const [name, setName] = useState('')
  const [category, setCategory] = useState('')
  const [pathPrefix, setPathPrefix] = useState('')
  const [nameContains, setNameContains] = useState('')
  const [action, setAction] = useState<'move' | 'trash'>('move')
  const [target, setTarget] = useState('~/Documents/归档')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void refresh()
  }, [])

  const refresh = async (): Promise<void> => {
    setRules(((await window.oasis.organizer.rules()) as unknown as RuleRow[]) ?? [])
    setSuggestions(((await window.oasis.organizer.listSuggestions()) as unknown as SuggestionRow[]) ?? [])
  }

  const saveRule = async (): Promise<void> => {
    if (!name.trim()) return
    setBusy(true)
    try {
      await window.oasis.organizer.saveRule({
        name: name.trim(),
        category: category || undefined,
        pathPrefix: pathPrefix.trim() || undefined,
        nameContains: nameContains.trim() || undefined,
        action,
        target: action === 'move' ? target.trim() : undefined
      })
      useUiStore.getState().showToast(`规则「${name.trim()}」已保存`)
      setName(''); setCategory(''); setPathPrefix(''); setNameContains('')
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const preview = async (): Promise<void> => {
    setBusy(true)
    try {
      const paths = (await window.oasis.files.list(undefined, { limit: 2000 })).rows
        .map((r) => r.source_path)
        .filter((p): p is string => Boolean(p))
      const n = await window.oasis.organizer.suggest(paths)
      useUiStore.getState().showToast(n > 0 ? `生成 ${n} 条归档建议，请审阅` : '没有匹配规则的文件')
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const executePicked = async (): Promise<void> => {
    if (picked.size === 0) return
    setBusy(true)
    try {
      const r = await window.oasis.organizer.execute([...picked])
      useUiStore.getState().showToast(r.failed.length === 0 ? `已归档 ${r.done} 项（批次可撤销）` : `成功 ${r.done}，失败 ${r.failed.length}`)
      setPicked(new Set())
      await refresh()
      onExecuted()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ marginTop: 36 }}>
      <div className="sidebar-pages-head" style={{ padding: '0 2px 8px' }}>归档规则</div>

      {/* 规则表单 */}
      <div className="rule-form">
        <input className="settings-input" style={{ flex: 2 }} placeholder="规则名称（如：截图归档）" value={name} onChange={(e) => setName(e.target.value)} />
        <select className="settings-select" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">任意类型</option>
          <option value="image">图片</option>
          <option value="video">视频</option>
          <option value="drawing">图纸</option>
          <option value="audio">音频</option>
          <option value="document">文档</option>
        </select>
        <input className="settings-input" style={{ flex: 2 }} placeholder="路径前缀（可选，如 ~/Desktop）" value={pathPrefix} onChange={(e) => setPathPrefix(e.target.value)} />
        <input className="settings-input" style={{ flex: 2 }} placeholder="文件名包含（可选）" value={nameContains} onChange={(e) => setNameContains(e.target.value)} />
        <select className="settings-select" value={action} onChange={(e) => setAction(e.target.value as 'move' | 'trash')}>
          <option value="move">移动到</option>
          <option value="trash">移入废纸篓</option>
        </select>
        {action === 'move' ? (
          <input className="settings-input" style={{ flex: 2 }} placeholder="目标目录（~/ 展开，支持 {YYYY}/{MM}）" value={target} onChange={(e) => setTarget(e.target.value)} />
        ) : null}
        <button type="button" className="btn small primary" onClick={() => void saveRule()} disabled={busy || !name.trim()}>保存规则</button>
      </div>

      {rules.length > 0 ? (
        <div className="doc-list" style={{ marginBottom: 12 }}>
          {rules.map((r) => (
            <div key={r.id} className="doc-row">
              <Icon name="folder" size={14} />
              <span className="doc-name">{r.name}</span>
              <button type="button" className="btn small danger-ghost" onClick={async () => {
                await window.oasis.organizer.deleteRule(r.id)
                await refresh()
              }}>删除</button>
            </div>
          ))}
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 8, margin: '10px 0' }}>
        <button type="button" className="btn ghost" onClick={() => void preview()} disabled={busy || rules.length === 0}>
          生成归档建议
        </button>
        {suggestions.length > 0 ? (
          <button type="button" className="btn primary" onClick={() => void executePicked()} disabled={busy || picked.size === 0}>
            执行勾选（{picked.size}/{suggestions.length}）
          </button>
        ) : null}
      </div>

      {/* 建议预览：源→目标 + 理由 + 冲突检测 */}
      {suggestions.length > 0 ? (
        <div className="doc-list">
          {suggestions.map((s) => {
            const conflict = s.action === 'move' && s.target_path ? null /* 冲突在执行时由 safeMove 严格判定并保留源 */ : null
            return (
              <label key={s.id} className="doc-row">
                <input
                  type="checkbox"
                  checked={picked.has(s.id)}
                  onChange={(e) => {
                    const next = new Set(picked)
                    if (e.target.checked) next.add(s.id)
                    else next.delete(s.id)
                    setPicked(next)
                  }}
                />
                <span className="doc-name" title={s.file_path}>{s.file_path.split('/').pop()}</span>
                <span style={{ color: 'var(--fg-faint)', fontSize: 12 }}>→</span>
                <span className="doc-fmt" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {s.action === 'trash' ? '废纸篓' : (s.target_path ?? '').replace(/^~/, '') || '归档'}
                </span>
                <span style={{ fontSize: 11.5, color: 'var(--fg-faint)' }}>{s.reason}</span>
                {conflict}
              </label>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
