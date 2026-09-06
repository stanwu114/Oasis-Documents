import { useEffect, useState } from 'react'
import { Icon } from './Icon'
import { useUiStore } from '../stores/uiStore'
import type { EmbeddingSettings, ModelStatus, ModelAssignments } from '../../../shared/ipc'

/* ================================================================
   设置页:本地向量模型(三卡片) + 功能设置 + 在线模型接入
   (监控目录/邮件订阅/平台账号/导入导出/索引诊断模块已移除:
    目录管理在侧栏"我的文件";系统状态独立成页)
   ================================================================ */

type ProviderId = 'bailian' | 'zhipu' | 'custom'

const PROVIDERS: { id: ProviderId; label: string; baseUrl: string; keyHint: string }[] = [
  { id: 'bailian', label: '百炼（阿里 DashScope）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyHint: 'sk-…' },
  { id: 'zhipu', label: '智谱（BigModel）', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyHint: '…' },
  { id: 'custom', label: '自定义（OpenAI 兼容）', baseUrl: '', keyHint: 'sk-…' }
]

/* 统一接入 → 旧引擎字段映射(bailian 走 DashScope=旧 qwen 通道) */
const PROVIDER_TO_LEGACY: Record<ProviderId, 'qwen' | 'zhipu' | 'custom'> = {
  bailian: 'qwen',
  zhipu: 'zhipu',
  custom: 'custom'
}

/* 本地模型卡片定义(仅展示这三张;legacy 'clip' 英文版不展示) */
const LOCAL_MODELS: { key: string; title: string; desc: string; badge?: string; badgeDanger?: boolean }[] = [
  { key: 'bge', title: '文本向量模型', desc: 'BGE-small-zh-v1.5 · 本地 ONNX · 约 100MB · 以文搜文语义检索' },
  { key: 'clip-zh', title: '图片向量模型', desc: '中文 CLIP ViT-B/16 int8 · 约 190MB · 以文搜图 / 以图搜图' },
  { key: 'vl-embedding', title: '多模态向量模型', desc: 'qwen3-vl-embedding · 图文统一向量空间', badge: '需要 GPU', badgeDanger: true }
]

type TestResult =
  | { ok: true; models: { id: string; category: string }[] }
  | { ok: false; error: string }
  | null

export function SettingsView(): React.ReactNode {
  const [embedding, setEmbedding] = useState<EmbeddingSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [models, setModels] = useState<ModelStatus[]>([])

  /* 在线接入表单(镜像 embedding.onlineProvider) */
  const [provider, setProvider] = useState<ProviderId>('bailian')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(PROVIDERS[0].baseUrl)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult>(null)
  const [assignments, setAssignments] = useState<ModelAssignments>({})

  useEffect(() => {
    /* 设置页初始化逐项容错:任何一项失败只影响对应区块,不拖垮整页 */
    void window.oasis.settings
      .getEmbedding()
      .then((e) => {
        setEmbedding(e)
        if (e.onlineProvider) {
          setProvider(e.onlineProvider.provider)
          setApiKey(e.onlineProvider.apiKey)
          setBaseUrl(e.onlineProvider.baseUrl || (PROVIDERS.find((p) => p.id === e.onlineProvider?.provider)?.baseUrl ?? ''))
        }
        if (e.modelAssignments) setAssignments(e.modelAssignments)
      })
      .catch((e: unknown) => useUiStore.getState().showToast(`配置读取失败：${e instanceof Error ? e.message : e}`, 'error'))
    void window.oasis.models.status().then(setModels).catch(() => undefined)
    const off = window.oasis.on.modelProgress((s) => {
      setModels((prev) => prev.map((m) => (m.name === s.name ? s : m)))
    })
    return off
  }, [])

  const switchProvider = (id: ProviderId): void => {
    setProvider(id)
    setBaseUrl(PROVIDERS.find((p) => p.id === id)?.baseUrl ?? '')
    setTestResult(null)
  }

  const runTest = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      const r = await window.oasis.llm.testProvider({ provider, apiKey, baseUrl: provider === 'custom' ? baseUrl : undefined })
      setTestResult(r)
      if (r.ok && r.models.length > 0) {
        /* 按类别自动指派:各类别取第一个命中;未命中保留现有 */
        setAssignments((prev) => {
          const next = { ...prev }
          for (const cat of ['embedding', 'text', 'multimodal', 'audio'] as const) {
            if (!next[cat]) {
              const hit = r.models.find((m) => m.category === cat)
              if (hit) next[cat] = hit.id
            }
          }
          return next
        })
      }
    } finally {
      setTesting(false)
    }
  }

  const categoryModels = (cat: 'embedding' | 'text' | 'multimodal' | 'audio'): string[] => {
    if (!testResult?.ok) return []
    const hits = testResult.models.filter((m) => m.category === cat).map((m) => m.id)
    /* 现有指派不在列表里也保留(可能是手填或列表接口不含) */
    const cur = assignments[cat]
    return cur && !hits.includes(cur) ? [cur, ...hits] : hits
  }

  const setAdvanced = (patch: Partial<EmbeddingSettings['advanced']>): void => {
    if (!embedding) return
    setEmbedding({ ...embedding, advanced: { ...embedding.advanced, ...patch } })
  }

  const save = async (): Promise<void> => {
    if (!embedding) return
    setSaving(true)
    try {
      const legacyKey = PROVIDER_TO_LEGACY[provider]
      const onlineOn = apiKey.trim().length > 0
      const next: EmbeddingSettings = {
        ...embedding,
        onlineProvider: { provider, apiKey, baseUrl },
        modelAssignments: assignments,
        /* 映射到既有引擎:向量走 providers.*,LLM/多模态走 onlineLlm/onlineMultimodal */
        defaultProvider: onlineOn && assignments.embedding ? legacyKey : 'local',
        providers: {
          ...embedding.providers,
          [legacyKey]: {
            ...embedding.providers[legacyKey],
            enabled: onlineOn && Boolean(assignments.embedding),
            apiKey,
            ...(assignments.embedding ? { model: assignments.embedding } : {}),
            ...(legacyKey === 'custom' && provider === 'custom' ? { baseUrl, dimensions: embedding.providers.custom.dimensions } : {})
          } as EmbeddingSettings['providers']['qwen']
        },
        onlineLlm: {
          enabled: onlineOn && Boolean(assignments.text),
          provider: legacyKey,
          apiKey,
          model: assignments.text ?? embedding.onlineLlm.model,
          ...(legacyKey === 'custom' ? { baseUrl } : {})
        },
        onlineMultimodal: {
          enabled: onlineOn && Boolean(assignments.multimodal),
          provider: legacyKey,
          apiKey,
          model: assignments.multimodal ?? embedding.onlineMultimodal.model,
          ...(legacyKey === 'custom' ? { baseUrl } : {})
        }
      }
      await window.oasis.settings.setEmbedding(next)
      setEmbedding(next)
      useUiStore.getState().showToast('设置已保存')
    } finally {
      setSaving(false)
    }
  }

  const modelStatusOf = (key: string): ModelStatus | undefined =>
    key === 'vl-embedding' ? undefined : models.find((m) => m.name === key)

  return (
    <div className="settings-view">
      <h1 className="view-title">设置</h1>
      <p className="view-sub">本地模型与在线模型接入。监控目录请到侧栏「我的文件」管理。</p>

      {/* 本地向量模型 */}
      <section className="settings-section">
        <h3>本地向量模型</h3>
        <div className="model-grid">
          {LOCAL_MODELS.map((m) => {
            const st = modelStatusOf(m.key)
            return (
              <div key={m.key} className="model-card">
                <div className="model-card-head">
                  <span className="model-card-title">{m.title}</span>
                  {m.badge ? <span className="model-badge-gpu">{m.badge}</span> : null}
                </div>
                <p className="model-card-desc">{m.desc}</p>
                {st ? (
                  <>
                    {st.downloading ? (
                      <div className="progress-track" style={{ margin: '8px 0 4px' }}>
                        <div className="progress-bar" style={{ width: `${Math.round(st.progress * 100)}%` }} />
                      </div>
                    ) : null}
                    <button
                      type="button"
                      className={`btn small ${st.downloaded ? 'ghost' : 'primary'}`}
                      disabled={st.downloading || st.downloaded}
                      onClick={() => {
                        void window.oasis.models.download(m.key).catch((e: unknown) =>
                          useUiStore.getState().showToast(`下载失败：${e instanceof Error ? e.message : e}`, 'error')
                        )
                      }}
                    >
                      {st.downloaded ? '已就绪' : st.downloading ? `${Math.round(st.progress * 100)}%` : '下载'}
                    </button>
                  </>
                ) : (
                  <p className="model-card-hint">本地推理包暂未内置——请通过下方「在线模型接入」使用,或等待后续版本</p>
                )}
              </div>
            )
          })}
        </div>
      </section>

      {/* 在线模型接入 */}
      <section className="settings-section">
        <h3>在线模型接入</h3>
        <p className="settings-value" style={{ lineHeight: 1.7, marginBottom: 12 }}>
          接入第三方大模型服务商后,自动拉取模型列表并按 向量 / 文本 / 多模态 / 音频 分类指派。Key 经系统钥匙串加密,仅存本机。
        </p>
        <div className="settings-row">
          <span>服务商</span>
          <select className="settings-select" value={provider} onChange={(e) => switchProvider(e.target.value as ProviderId)}>
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </div>
        <div className="settings-row">
          <span>API Key</span>
          <input
            className="settings-input"
            style={{ width: 320 }}
            type="password"
            placeholder={PROVIDERS.find((p) => p.id === provider)?.keyHint}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>
        <div className="settings-row">
          <span>Base URL</span>
          <input
            className="settings-input"
            style={{ width: 320 }}
            placeholder={provider === 'custom' ? 'https://your-host/v1' : PROVIDERS.find((p) => p.id === provider)?.baseUrl}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            readOnly={provider !== 'custom' && baseUrl === PROVIDERS.find((p) => p.id === provider)?.baseUrl}
          />
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '10px 0' }}>
          <button type="button" className="btn ghost" onClick={() => void runTest()} disabled={testing || !apiKey.trim()}>
            {testing ? '测试中…' : '测试连接'}
          </button>
          {testResult ? (
            testResult.ok ? (
              <span className="settings-value ok" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <Icon name="search" size={12} /> 连接成功 · 拉取到 {testResult.models.length} 个模型
              </span>
            ) : (
              <span style={{ color: 'var(--danger)', fontSize: 12.5 }}>{testResult.error}</span>
            )
          ) : (
            <span style={{ color: 'var(--fg-faint)', fontSize: 12 }}>先测试连接,通过后选择各类模型</span>
          )}
        </div>

        {/* 模型分类指派(测试通过后展示) */}
        {testResult?.ok ? (
          <div className="model-assign-grid">
            {([
              { key: 'embedding', label: '向量模型', hint: '文本语义检索' },
              { key: 'text', label: '文本模型', hint: 'AI 打标 / 理解' },
              { key: 'multimodal', label: '多模态模型', hint: '图片理解' },
              { key: 'audio', label: '音频模型', hint: '语音(预留)' }
            ] as const).map((c) => (
              <div key={c.key} className="model-assign-row">
                <div className="model-assign-label">
                  <span>{c.label}</span>
                  <em>{c.hint}</em>
                </div>
                <select
                  className="settings-select"
                  value={assignments[c.key] ?? ''}
                  onChange={(e) => setAssignments({ ...assignments, [c.key]: e.target.value || undefined })}
                >
                  <option value="">未指派</option>
                  {categoryModels(c.key).map((id) => (
                    <option key={id} value={id}>{id}</option>
                  ))}
                </select>
              </div>
            ))}
            {testResult.models.length > 0 && categoryModels('embedding').length === 0 ? (
              <p className="model-card-hint">该服务商列表中没有识别出向量模型,可直接在设置文件中手动指定,或换用本地向量模型</p>
            ) : null}
          </div>
        ) : null}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
          <button type="button" className="btn primary" onClick={() => void save()} disabled={saving}>
            {saving ? '保存中…' : '保存设置'}
          </button>
        </div>
      </section>

      {/* 功能设置 */}
      {embedding ? (
        <section className="settings-section">
          <h3>功能设置</h3>
          <div className="settings-row">
            <span>在线请求并发数</span>
            <input
              className="settings-input" style={{ width: 100 }} type="number" min={1} max={16}
              value={embedding.advanced.onlineConcurrency}
              onChange={(e) => setAdvanced({ onlineConcurrency: Math.max(1, parseInt(e.target.value, 10) || 1) })}
            />
          </div>
          <div className="settings-row">
            <span>在线超时（毫秒）</span>
            <input
              className="settings-input" style={{ width: 100 }} type="number" min={5000} step={1000}
              value={embedding.advanced.timeoutMs}
              onChange={(e) => setAdvanced({ timeoutMs: Math.max(5000, parseInt(e.target.value, 10) || 30000) })}
            />
          </div>
          <div className="settings-row">
            <span>向量写入批次大小</span>
            <input
              className="settings-input" style={{ width: 100 }} type="number" min={8} max={128}
              value={embedding.advanced.batchSize}
              onChange={(e) => setAdvanced({ batchSize: Math.max(8, parseInt(e.target.value, 10) || 32) })}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
            <button type="button" className="btn primary" onClick={() => void save()} disabled={saving}>
              {saving ? '保存中…' : '保存设置'}
            </button>
          </div>
        </section>
      ) : null}

      {/* 关于 */}
      <section className="settings-section">
        <h3>关于</h3>
        <p className="settings-value" style={{ lineHeight: 1.8 }}>
          Oasis Documents · 本地优先的数字资产管理
          <br />导入 / 整理 / 检索 / 收藏 / 系统状态
        </p>
      </section>
    </div>
  )
}
