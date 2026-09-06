import { useEffect, useState } from 'react'
import { Icon } from './Icon'
import { useUiStore } from '../stores/uiStore'
import type { EmbeddingSettings, ModelStatus, OnlineModelConf } from '../../../shared/ipc'

const MODEL_LABEL: Record<string, string> = {
  bge: 'BGE-small-zh（文本语义检索，约 100MB）',
  clip: 'CLIP ViT-B/32（图片检索 / 以文搜图，约 150MB）'
}

export function SettingsView(): React.ReactNode {
  const [watchPaths, setWatchPaths] = useState<string[]>([])
  const [newPath, setNewPath] = useState('')
  const [embedding, setEmbedding] = useState<EmbeddingSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [models, setModels] = useState<ModelStatus[]>([])
  const [stats, setStats] = useState<Awaited<ReturnType<typeof window.oasis.diag.indexStats>> | null>(null)

  useEffect(() => {
    void window.oasis.files.getWatchPaths().then(setWatchPaths)
    void window.oasis.settings.getEmbedding().then(setEmbedding)
    void window.oasis.models.status().then(setModels)
    void window.oasis.diag.indexStats().then(setStats)
    const off = window.oasis.on.modelProgress((s) => {
      setModels((prev) => prev.map((m) => (m.name === s.name ? s : m)))
    })
    return off
  }, [])

  const addPath = async (): Promise<void> => {
    const p = newPath.trim()
    if (!p) return
    await window.oasis.files.addWatchPath(p) /* ~ 展开由主进程处理 */
    setWatchPaths(await window.oasis.files.getWatchPaths())
    setNewPath('')
  }

  const pickDirectories = async (): Promise<void> => {    const picked = await window.oasis.files.pickDirectories()
    if (picked.length === 0) return
    await window.oasis.files.addWatchPaths(picked)
    setWatchPaths(await window.oasis.files.getWatchPaths())
    useUiStore.getState().showToast(`已添加 ${picked.length} 个监控目录`)
  }

  /* F05：导入导出 */
  const onImport = async (kind: 'bookmarks' | 'opml' | 'json'): Promise<void> => {
    const exts = kind === 'bookmarks' ? ['html', 'htm'] : kind === 'opml' ? ['opml', 'xml'] : ['json']
    const path = await window.oasis.io.pickOpenFile(exts)
    if (!path) return
    try {
      const text = await window.oasis.io.readFile(path)
      if (kind === 'bookmarks') {
        const r = await window.oasis.io.importBookmarks(text)
        useUiStore.getState().showToast(`书签导入完成：成功 ${r.added}，失败 ${r.failed}`)
      } else if (kind === 'opml') {
        const r = await window.oasis.io.importOpml(text)
        useUiStore.getState().showToast(`订阅导入完成：新增 ${r.added}，失败 ${r.failed}`)
      } else {
        const r = await window.oasis.io.importJson(text)
        useUiStore.getState().showToast(`JSON 导入完成：收藏 ${r.contents}，订阅 ${r.subscriptions}`)
      }
    } catch (e) {
      useUiStore.getState().showToast(`导入失败：${e instanceof Error ? e.message : e}`, 'error')
    } finally {
    }
  }

  const onExport = async (): Promise<void> => {
    const path = await window.oasis.io.pickSaveFile(`oasis-documents-backup-${new Date().toISOString().slice(0, 10)}.json`)
    if (!path) return
    try {
      const json = await window.oasis.io.exportJson()
      await window.oasis.io.writeFile(path, json)
      useUiStore.getState().showToast(`已导出`)
    } catch (e) {
      useUiStore.getState().showToast(`导出失败：${e instanceof Error ? e.message : e}`, 'error')
    } finally {
    }
  }

  const removePath = async (p: string): Promise<void> => {
    await window.oasis.files.removeWatchPath(p)
    setWatchPaths(await window.oasis.files.getWatchPaths())
  }

  const saveEmbedding = async (): Promise<void> => {
    if (!embedding) return
    setSaving(true)
    try {
      await window.oasis.settings.setEmbedding(embedding)
    } finally {
      setSaving(false)
    }
  }

  const setProvider = (p: EmbeddingSettings['defaultProvider']): void => {
    if (!embedding) return
    /* R10：选为默认服务商即视为启用——旧实现从不设置 enabled，
       填了 Key 也被静默判为未启用而回落本地模型 */
    const providers = { ...embedding.providers }
    if (p !== 'local' && p !== 'custom') {
      const conf = providers[p] as EmbeddingSettings['providers']['openai']
      if (conf.apiKey) providers[p] = { ...conf, enabled: true }
    } else if (p === 'custom') {
      const conf = providers.custom
      if (conf.apiKey) providers.custom = { ...conf, enabled: true }
    }
    setEmbedding({ ...embedding, defaultProvider: p, providers })
  }

  const setProviderConf = (
    key: 'openai' | 'zhipu' | 'qwen' | 'custom',
    patch: Partial<EmbeddingSettings['providers']['openai']>
  ): void => {
    if (!embedding) return
    setEmbedding({
      ...embedding,
      providers: { ...embedding.providers, [key]: { ...embedding.providers[key], ...patch } }
    })
  }

  return (
    <div className="settings-view">
      <h1 className="view-title">设置</h1>
      <p className="view-sub">监控目录与嵌入引擎配置。所有数据仅存本机。</p>

      {/* 监控目录 */}
      <section className="settings-section">
        <h3>监控目录</h3>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <button type="button" className="btn primary" onClick={() => void pickDirectories()}>
            <Icon name="folder" size={13} /> 选择文件夹…
          </button>
          <input
            className="settings-input"
            style={{ flex: 1 }}
            placeholder="或手动输入路径，如 ~/Downloads（回车添加）"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void addPath()}
          />
          <button type="button" className="btn ghost" onClick={() => void addPath()} disabled={!newPath.trim()}>
            添加
          </button>
        </div>
        {watchPaths.map((p) => (
          <div key={p} className="watch-path-row">
            <Icon name="folder" size={14} />
            <span className="watch-path-text" title={p}>{p}</span>
            <button type="button" className="btn small danger-ghost" onClick={() => void removePath(p)}>
              移除
            </button>
          </div>
        ))}
        {watchPaths.length === 0 ? (
          <p style={{ color: 'var(--fg-faint)', fontSize: 12.5, margin: '6px 0' }}>
            添加目录后，其中的图片/文档会被自动索引（node_modules、.git 等自动忽略）。
          </p>
        ) : null}
      </section>

      {/* 模型管理 */}
      <section className="settings-section">
        <h3>本地模型（未下载时检索回退关键词匹配）</h3>
        {models.map((m) => (
          <div key={m.name} className="skill-row" style={{ borderTop: m === models[0] ? 'none' : '1px solid var(--border)' }}>
            <div className="skill-body">
              <span className="skill-name">{MODEL_LABEL[m.name] ?? m.name}</span>
              {m.downloading ? (
                <div className="progress-track" style={{ margin: '6px 0 2px' }}>
                  <div className="progress-bar" style={{ width: `${Math.round(m.progress * 100)}%` }} />
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className={`btn small ${m.downloaded ? 'ghost' : 'primary'}`}
              disabled={m.downloading || m.downloaded}
              onClick={() => {
                void window.oasis.models.download(m.name).catch((e: unknown) =>
                  useUiStore.getState().showToast(`下载失败：${e instanceof Error ? e.message : e}`, 'error')
                )
              }}
            >
              {m.downloaded ? '已就绪' : m.downloading ? `${Math.round(m.progress * 100)}%` : '下载'}
            </button>
          </div>
        ))}
      </section>

      {/* 嵌入引擎（本地/在线检索向量来源） */}
      {embedding ? (
        <section className="settings-section">
          <h3>检索嵌入引擎（向量来源：本地 ONNX 或 在线嵌入 API）</h3>
          <div className="seg" style={{ display: 'inline-flex', marginBottom: 12 }}>
            {(['local', 'openai', 'zhipu', 'qwen', 'custom'] as const).map((p) => (
              <button key={p} type="button" className={embedding.defaultProvider === p ? 'on' : ''} onClick={() => setProvider(p)}>
                {p === 'local' ? '本地 ONNX' : p === 'openai' ? 'OpenAI' : p === 'zhipu' ? '智谱' : p === 'qwen' ? '通义' : '自定义'}
              </button>
            ))}
          </div>

          {embedding.defaultProvider === 'local' ? (
            <p className="settings-value" style={{ lineHeight: 1.8 }}>
              本地模式：BGE-small-zh（文本）+ CLIP ViT-B/32（图片），ONNX CPU 推理，完全离线。
              <br />模型未下载时检索自动回退到关键词匹配。图片搜索始终使用本地 CLIP。
            </p>
          ) : (
            <ProviderForm embedding={embedding} setProviderConf={setProviderConf} />
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
            <button type="button" className="btn primary" onClick={() => void saveEmbedding()} disabled={saving}>
              {saving ? '保存中…' : '保存设置'}
            </button>
          </div>
        </section>
      ) : null}

      {/* 在线文本模型（LLM：文档 AI 打标） */}
      {embedding ? (
        <section className="settings-section">
          <h3>在线文本模型（LLM · 文件收藏的文档 AI 打标）</h3>
          <p className="settings-value" style={{ margin: '0 0 10px', lineHeight: 1.7 }}>
            配置后导入的收藏内容由大模型归纳打标（如「极简装修」「K8s 运维」）；未配置或调用失败自动回退本地关键短语抽取。
          </p>
          <OnlineModelForm
            conf={embedding.onlineLlm}
            onChange={(patch) => setEmbedding({ ...embedding, onlineLlm: { ...embedding.onlineLlm, ...patch } })}
            defaultModels={['glm-4-flash', 'qwen-plus', 'gpt-4o-mini']}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
            <button type="button" className="btn primary" onClick={() => void saveEmbedding()} disabled={saving}>
              {saving ? '保存中…' : '保存设置'}
            </button>
          </div>
        </section>
      ) : null}

      {/* 在线多模态模型（预留：图片理解） */}
      {embedding ? (
        <section className="settings-section">
          <h3>在线多模态模型（图片理解 · 预留）</h3>
          <p className="settings-value" style={{ margin: '0 0 10px', lineHeight: 1.7 }}>
            为后续的图片内容理解（OCR 增强、图片自动描述）预留；本期可先配置保存。
          </p>
          <OnlineModelForm
            conf={embedding.onlineMultimodal}
            onChange={(patch) => setEmbedding({ ...embedding, onlineMultimodal: { ...embedding.onlineMultimodal, ...patch } })}
            defaultModels={['qwen-vl-plus', 'glm-4v-flash', 'gpt-4o-mini']}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
            <button type="button" className="btn primary" onClick={() => void saveEmbedding()} disabled={saving}>
              {saving ? '保存中…' : '保存设置'}
            </button>
          </div>
        </section>
      ) : null}

      {/* Newsletter / IMAP 邮件订阅 */}
      <NewsletterSection />

      {/* L3 平台账号 */}
      <PlatformAccountsSection />

      {/* 12.2：索引状态诊断 */}
      <section className="settings-section">
        <h3>索引状态</h3>
        {stats ? (
          <>
            <div className="settings-row"><span>已索引 / 待处理</span><span className="settings-value">{stats.indexed} / {stats.pending}</span></div>
            <div className="settings-row"><span>嵌入队列</span><span className="settings-value">{stats.queueSize === 0 ? '空闲' : `${stats.queueSize} 个任务`}</span></div>
            <div className="settings-row"><span>全文索引（FTS5）</span><span className={stats.ftsRows >= 0 ? 'settings-value ok' : 'settings-value muted'}>{stats.ftsRows >= 0 ? `${stats.ftsRows} 条` : '不可用（回退 LIKE）'}</span></div>
            <div className="settings-row"><span>文本模型</span><span className={stats.model.textReady ? 'settings-value ok' : 'settings-value muted'}>{stats.model.textReady ? '就绪' : '未就绪'}</span></div>
            <div className="settings-row"><span>图片模型（CLIP）</span><span className={stats.model.imageReady ? 'settings-value ok' : 'settings-value muted'}>{stats.model.imageReady ? '就绪' : '未就绪'}</span></div>
            {Object.keys(stats.byType).length > 0 ? (
              <div className="settings-row"><span>内容分布</span>
                <span className="settings-value">{Object.entries(stats.byType).map(([k, v]) => `${k}:${v}`).join(' · ')}</span>
              </div>
            ) : null}
            {stats.recentErrors.length > 0 ? (
              <div style={{ marginTop: 8 }}>
                <div className="report-head">嵌入失败原因</div>
                {stats.recentErrors.map((e) => (
                  <div key={e.err} className="report-fail-row"><span>· {String(e.err).slice(0, 60)}</span><span className="report-fail-count">×{e.n}</span></div>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <p className="settings-value">载入中…</p>
        )}
      </section>

      {/* F05：数据导入导出 */}
      <section className="settings-section">
        <h3>数据导入 / 导出</h3>
        <p className="settings-value" style={{ lineHeight: 1.7, marginBottom: 10 }}>
          书签 HTML / OPML 订阅 / JSON 全量（收藏、标签、订阅、已读星标）。导出再导入不会重复放大数据。
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn ghost" onClick={() => void onImport('bookmarks')}>导入浏览器书签…</button>
          <button type="button" className="btn ghost" onClick={() => void onImport('opml')}>导入 OPML 订阅…</button>
          <button type="button" className="btn ghost" onClick={() => void onImport('json')}>导入 JSON 备份…</button>
          <button type="button" className="btn primary" onClick={() => void onExport()}>导出全部数据…</button>
        </div>
      </section>

      {/* 关于 */}
      <section className="settings-section">
        <h3>关于</h3>
        <p className="settings-value" style={{ lineHeight: 1.8 }}>
          Oasis Documents v0.1.0 · 整理 / 检索 / 收藏 / 订阅
          <br />视频语义检索（SentrySearch）已预留，本期未启用。
        </p>
      </section>
    </div>
  )
}

/** 在线模型通用表单（LLM / 多模态共用） */
function OnlineModelForm({
  conf,
  onChange,
  defaultModels
}: {
  conf: OnlineModelConf
  onChange: (patch: Partial<OnlineModelConf>) => void
  defaultModels: string[]
}): React.ReactNode {
  return (
    <>
      <div className="settings-row">
        <span>启用</span>
        <button
          type="button"
          className={`btn small ${conf.enabled ? 'primary' : 'ghost'}`}
          onClick={() => onChange({ enabled: !conf.enabled })}
        >
          {conf.enabled ? '已启用' : '未启用'}
        </button>
      </div>
      <div className="settings-row">
        <span>服务商</span>
        <select
          className="settings-select"
          value={conf.provider}
          onChange={(e) => onChange({ provider: e.target.value as OnlineModelConf['provider'] })}
        >
          <option value="zhipu">智谱（BigModel）</option>
          <option value="qwen">通义（DashScope）</option>
          <option value="openai">OpenAI</option>
          <option value="custom">自定义（OpenAI 兼容）</option>
        </select>
      </div>
      <div className="settings-row">
        <span>API Key</span>
        <input
          className="settings-input"
          style={{ width: 300 }}
          type="password"
          placeholder="sk-…"
          value={conf.apiKey}
          onChange={(e) => onChange({ apiKey: e.target.value })}
        />
      </div>
      <div className="settings-row">
        <span>模型</span>
        <input
          className="settings-input"
          style={{ width: 300 }}
          list={`models-${defaultModels[0]}`}
          value={conf.model}
          onChange={(e) => onChange({ model: e.target.value })}
        />
        <datalist id={`models-${defaultModels[0]}`}>
          {defaultModels.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </div>
      {conf.provider === 'custom' ? (
        <div className="settings-row">
          <span>Base URL</span>
          <input
            className="settings-input"
            style={{ width: 300 }}
            placeholder="https://your-host/v1"
            value={conf.baseUrl ?? ''}
            onChange={(e) => onChange({ baseUrl: e.target.value })}
          />
        </div>
      ) : null}
    </>
  )
}

function ProviderForm({
  embedding,
  setProviderConf
}: {
  embedding: EmbeddingSettings
  setProviderConf: (
    key: 'openai' | 'zhipu' | 'qwen' | 'custom',
    patch: Partial<EmbeddingSettings['providers']['openai']>
  ) => void
}): React.ReactNode {
  const key = embedding.defaultProvider as 'openai' | 'zhipu' | 'qwen' | 'custom'
  const conf = embedding.providers[key]

  return (
    <>
      <div className="settings-row">
        <span>API Key</span>
        <input
          className="settings-input"
          style={{ width: 300 }}
          type="password"
          placeholder="sk-…（保存后加密存储）"
          value={conf.apiKey}
          onChange={(e) => setProviderConf(key, { apiKey: e.target.value, enabled: e.target.value.trim().length > 0 })}
        />
      </div>
      <div className="settings-row">
        <span>模型</span>
        <input
          className="settings-input"
          style={{ width: 300 }}
          value={conf.model}
          onChange={(e) => setProviderConf(key, { model: e.target.value })}
        />
      </div>
      {key === 'custom' ? (
        <>
          <div className="settings-row">
            <span>Base URL（OpenAI 兼容）</span>
            <input
              className="settings-input"
              style={{ width: 300 }}
              placeholder="https://your-host/v1"
              value={(conf as EmbeddingSettings['providers']['custom']).baseUrl}
              onChange={(e) => setProviderConf('custom', { baseUrl: e.target.value } as Partial<EmbeddingSettings['providers']['openai']>)}
            />
          </div>
          <div className="settings-row">
            <span>向量维度</span>
            <input
              className="settings-input"
              style={{ width: 120 }}
              type="number"
              value={(conf as EmbeddingSettings['providers']['custom']).dimensions || ''}
              onChange={(e) =>
                setProviderConf('custom', { dimensions: parseInt(e.target.value, 10) || 0 } as Partial<EmbeddingSettings['providers']['openai']>)
              }
            />
          </div>
        </>
      ) : null}
      <p style={{ color: 'var(--fg-faint)', fontSize: 12, margin: '8px 0 0' }}>
        在线失败时自动降级本地模型（若已下载）。API Key 通过系统钥匙串加密。
      </p>
    </>
  )
}


/* ============ Newsletter / IMAP 配置 ============ */
function NewsletterSection(): React.ReactNode {
  const [conf, setConf] = useState<Awaited<ReturnType<typeof window.oasis.newsletter.conf>> | null>(null)
  const [host, setHost] = useState('')
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [filters, setFilters] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.oasis.newsletter.conf().then((c) => {
      setConf(c)
      setHost(c.host)
      setUser(c.user)
      setFilters(c.fromFilters.join(', '))
    })
  }, [])

  const save = async (enabled?: boolean): Promise<void> => {
    setBusy(true)
    try {
      await window.oasis.newsletter.save({
        enabled: enabled ?? conf?.enabled,
        host,
        user,
        ...(password ? { password } : {}),
        fromFilters: filters.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
      })
      setPassword('')
      const c = await window.oasis.newsletter.conf()
      setConf(c)
      useUiStore.getState().showToast('邮件订阅配置已保存')
    } finally {
      setBusy(false)
    }
  }

  const syncNow = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.oasis.newsletter.sync()
      if (r.error) useUiStore.getState().showToast(`拉取失败：${r.error}`, 'error')
      else useUiStore.getState().showToast(`拉取 ${r.fetched} 封，归档 ${r.archived} 封`)
    } finally {
      setBusy(false)
    }
  }

  if (!conf) return null
  return (
    <section className="settings-section">
      <h3>邮件订阅（IMAP 归档）</h3>
      <p className="settings-value" style={{ lineHeight: 1.7, marginBottom: 10 }}>
        定时拉取邮箱订阅邮件，正文进入统一检索。密码经系统钥匙串加密，仅用于 IMAP 登录。
      </p>
      <div className="settings-row"><span>启用</span>
        <button type="button" className={`btn small ${conf.enabled ? 'primary' : 'ghost'}`} disabled={busy} onClick={() => void save(!conf.enabled)}>
          {conf.enabled ? '已启用' : '未启用'}
        </button>
      </div>
      <div className="settings-row"><span>IMAP 服务器</span>
        <input className="settings-input" style={{ width: 260 }} placeholder="imap.qq.com" value={host} onChange={(e) => setHost(e.target.value)} />
      </div>
      <div className="settings-row"><span>账号</span>
        <input className="settings-input" style={{ width: 260 }} value={user} onChange={(e) => setUser(e.target.value)} />
      </div>
      <div className="settings-row"><span>{conf.passwordConfigured ? '密码（已配置，留空不修改）' : '密码 / 授权码'}</span>
        <input className="settings-input" style={{ width: 260 }} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <div className="settings-row"><span>发件人过滤（逗号分隔，空=全部）</span>
        <input className="settings-input" style={{ width: 260 }} placeholder="newsletter, 周刊" value={filters} onChange={(e) => setFilters(e.target.value)} />
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
        <button type="button" className="btn ghost" onClick={() => void syncNow()} disabled={busy || !conf.enabled}>立即拉取</button>
        <button type="button" className="btn primary" onClick={() => void save()} disabled={busy}>保存</button>
      </div>
    </section>
  )
}

/* ============ L3 平台账号 ============ */
function PlatformAccountsSection(): React.ReactNode {
  const [accounts, setAccounts] = useState<Awaited<ReturnType<typeof window.oasis.accounts.list>>>([])
  const [mpName, setMpName] = useState('')

  useEffect(() => {
    void window.oasis.accounts.list().then(setAccounts)
  }, [])

  return (
    <section className="settings-section">
      <h3>平台账号（L3）</h3>
      <p className="settings-value" style={{ lineHeight: 1.7, marginBottom: 10 }}>
        登录态保存在独立持久会话中（不与主窗口共享）。仅承载登录与手动同步；
        <b style={{ color: 'var(--danger)' }}>频繁自动抓取有封号风险</b>，本应用不做后台自动爬取。
      </p>
      {accounts.map((a) => (
        <div key={a.id} className="settings-row">
          <span>{a.label}</span>
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {a.lastAction ? <span className="settings-value muted">{new Date(a.lastAction).toLocaleDateString('zh-CN')} 活动过</span> : null}
            <button type="button" className="btn small ghost" onClick={async () => {
              await window.oasis.accounts.login(a.id)
              setAccounts(await window.oasis.accounts.list())
            }}>打开登录窗口</button>
          </span>
        </div>
      ))}
      <div className="settings-row" style={{ marginTop: 6 }}>
        <span>订阅公众号（RSSHub 桥接，无需微信登录）</span>
        <span style={{ display: 'flex', gap: 8 }}>
          <input className="settings-input" style={{ width: 180 }} placeholder="公众号名称" value={mpName} onChange={(e) => setMpName(e.target.value)} />
          <button type="button" className="btn small primary" disabled={!mpName.trim()} onClick={async () => {
            try {
              await window.oasis.accounts.subscribeMp(mpName.trim())
              useUiStore.getState().showToast(`已订阅公众号「${mpName.trim()}」，文章将出现在订阅时间线`)
              setMpName('')
            } catch (e) {
              useUiStore.getState().showToast(`订阅失败：${e instanceof Error ? e.message : e}`, 'error')
            }
          }}>订阅</button>
        </span>
      </div>
    </section>
  )
}
