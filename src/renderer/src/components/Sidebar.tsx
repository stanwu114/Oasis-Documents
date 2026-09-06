import { useEffect, useState } from 'react'
import { useUiStore, type View } from '../stores/uiStore'
import { Icon } from './Icon'
import { platformLabel } from '../../../shared/platform'

interface WatchTree {
  watchPath: string
  name: string
  subDirs: { name: string; path: string }[]
}

interface PlatformGroup {
  platform: string
  count: number
}

export function Sidebar(): React.ReactNode {
  const view = useUiStore((s) => s.view)
  const theme = useUiStore((s) => s.theme)
  const currentDir = useUiStore((s) => s.currentDir)
  const importProgress = useUiStore((s) => s.importProgress)
  const collectionPlatform = useUiStore((s) => s.collectionPlatform)
  const contentsVersion = useUiStore((s) => s.contentsVersion)
  const [tree, setTree] = useState<WatchTree[]>([])
  const [expanded, setExpanded] = useState(true)
  /* 我的收藏:按平台分组的二级目录 */
  const [platforms, setPlatforms] = useState<PlatformGroup[]>([])
  const [collectionExpanded, setCollectionExpanded] = useState(true)

  const refreshTree = async (): Promise<void> => {
    setTree(await window.oasis.files.listSubDirs())
  }

  const refreshCollections = async (): Promise<void> => {
    try {
      const rows = await window.oasis.platform.listContents()
      const m = new Map<string, number>()
      for (const r of rows) m.set(r.platform, (m.get(r.platform) ?? 0) + 1)
      setPlatforms(
        [...m.entries()]
          .map(([platform, count]) => ({ platform, count }))
          .sort((a, b) => b.count - a.count)
      )
    } catch {
      setPlatforms([])
    }
  }

  useEffect(() => {
    void refreshTree()
  }, [view, currentDir])

  useEffect(() => {
    void refreshCollections()
  }, [view, contentsVersion])

  const onImport = async (): Promise<void> => {
    const picked = await window.oasis.files.pickDirectories()
    if (picked.length === 0) return
    await window.oasis.files.addWatchPaths(picked)
    await refreshTree()
    useUiStore.getState().showToast(`已导入 ${picked.length} 个文件夹，正在自动索引`)
  }

  const onRemove = async (path: string, name: string): Promise<void> => {
    const ok = window.confirm(
      `删除「${name}」？\n\n该文件夹及其内容将从「我的文件」中移除（取消监控并清除索引），磁盘上的文件不会被删除。`
    )
    if (!ok) return
    try {
      const r = await window.oasis.files.removeWatchDir(path)
      useUiStore.getState().showToast(`已删除「${name}」（从我的文件移除 ${r.removedContents} 条）`)
      if (useUiStore.getState().currentDir?.startsWith(path)) {
        useUiStore.getState().openDir(null)
      }
      useUiStore.getState().bumpContents() /* 列表立即刷新 */
      await refreshTree()
    } catch (e) {
      useUiStore.getState().showToast(`删除失败：${e instanceof Error ? e.message : e}`, 'error')
    }
  }

  const btn = (active: boolean): string => `sidebar-btn${active ? ' active' : ''}`
  const nav = (v: View): void => useUiStore.getState().setView(v)

  return (
    <aside className="sidebar">
      <div className="sidebar-top" />
      <div className="sidebar-brand">
        <span className="brand-word">Oasis</span>
        <span className="brand-sub">Documents</span>
      </div>

      {/* 导入文件夹（原搜索框位置） */}
      <div className="sidebar-actions">
        <button type="button" className="sidebar-btn primary" onClick={() => void onImport()}>
          导入文件夹
        </button>
      </div>

      <nav className="sidebar-nav">
        {/* 我的文件（带二级目录树） */}
        <button type="button" className={btn(view === 'files' && !currentDir)} onClick={() => useUiStore.getState().openDir(null)}>
          <Icon name="files" size={15} /> 我的文件
        {/* 展开/收起指示：双箭头符号（› ‹ 造型清晰），点击整个区域可切换 */}
        <span
          role="button"
          tabIndex={-1}
          aria-label={expanded ? '收起文件夹列表' : '展开文件夹列表'}
          className={`chevron${expanded ? ' open' : ''}`}
          style={{
            marginLeft: 'auto',
            fontSize: 16,
            lineHeight: 1,
            color: expanded ? 'var(--accent)' : 'var(--fg-muted)',
            padding: '2px 4px',
            marginRight: -4,
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 0.18s ease, color 0.12s',
            display: 'inline-flex',
            alignItems: 'center',
            cursor: 'pointer'
          }}
          onClick={(e) => {
            e.stopPropagation()
            setExpanded(!expanded)
          }}
        >
          ›
        </span>
        </button>

        {expanded ? (
          <div className="sidebar-tree">
            {tree.map((t) => (
              <div key={t.watchPath} className={`tree-row${currentDir === t.watchPath ? ' active' : ''}`}>
                <button
                  type="button"
                  className="tree-row-main"
                  onClick={() => useUiStore.getState().openDir(t.watchPath)}
                  title={t.watchPath}
                >
                  <Icon name="folder" size={13} />
                  <span className="tree-name">{t.name}</span>
                  {importProgress ? (
                    <span
                      role="button"
                      tabIndex={-1}
                      className="tree-progress"
                      title={`导入与向量化进度 ${importProgress.percent}%（点击查看详情）`}
                      onClick={(e) => {
                        e.stopPropagation()
                        useUiStore.getState().setImportModalHidden(false) /* 回弹进度弹窗 */
                      }}
                    >
                      {importProgress.percent}%
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  className="tree-rename"
                  title="删除文件夹（从我的文件移除及其内容，不删磁盘文件）"
                  onClick={() => void onRemove(t.watchPath, t.name)}
                >
                  ✕
                </button>
              </div>
            ))}
            {tree.length === 0 ? (
              <p className="tree-empty">导入文件夹后这里显示目录</p>
            ) : null}
          </div>
        ) : null}

        {/* 我的收藏(紧随我的文件,二级目录按平台分组) */}
        <button
          type="button"
          className={btn(view === 'platform' && !collectionPlatform)}
          onClick={() => useUiStore.getState().openCollection(null)}
        >
          <Icon name="doc" size={15} /> 我的收藏
          <span
            role="button"
            tabIndex={-1}
            aria-label={collectionExpanded ? '收起平台列表' : '展开平台列表'}
            className={`chevron${collectionExpanded ? ' open' : ''}`}
            style={{
              marginLeft: 'auto',
              fontSize: 16,
              lineHeight: 1,
              color: collectionExpanded ? 'var(--accent)' : 'var(--fg-muted)',
              padding: '2px 4px',
              marginRight: -4,
              transform: collectionExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 0.18s ease, color 0.12s',
              display: 'inline-flex',
              alignItems: 'center',
              cursor: 'pointer'
            }}
            onClick={(e) => {
              e.stopPropagation()
              setCollectionExpanded(!collectionExpanded)
            }}
          >
            ›
          </span>
        </button>

        {collectionExpanded ? (
          <div className="sidebar-tree">
            {platforms.map((p) => (
              <div
                key={p.platform}
                className={`tree-row${view === 'platform' && collectionPlatform === p.platform ? ' active' : ''}`}
              >
                <button
                  type="button"
                  className="tree-row-main"
                  onClick={() => useUiStore.getState().openCollection(p.platform)}
                  title={platformLabel(p.platform)}
                >
                  <Icon name="folder" size={13} />
                  <span className="tree-name">{platformLabel(p.platform)}</span>
                  <span className="tree-progress" title="收藏数">
                    {p.count}
                  </span>
                </button>
              </div>
            ))}
            {platforms.length === 0 ? (
              <p className="tree-empty">粘贴链接导入后这里按平台显示</p>
            ) : null}
          </div>
        ) : null}

        <button type="button" className={btn(view === 'search')} onClick={() => nav('search')}>
          <Icon name="search" size={15} /> 文件搜索
        </button>
        <button type="button" className={btn(view === 'organize')} onClick={() => nav('organize')}>
          <Icon name="broom" size={15} /> 文件整理
        </button>
        <button type="button" className={btn(view === 'status')} onClick={() => nav('status')}>
          <Icon name="gauge" size={15} /> 系统状态
        </button>
      </nav>

      <div className="sidebar-sections" />

      <div className="sidebar-bottom">
        <button type="button" className={btn(view === 'settings')} onClick={() => nav('settings')}>
          <Icon name="settings" size={15} /> 设置
        </button>
        <button type="button" className="sidebar-btn" onClick={() => useUiStore.getState().toggleTheme()}>
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={14} />
          {theme === 'dark' ? '浅色' : '深色'}
        </button>
      </div>
    </aside>
  )
}
