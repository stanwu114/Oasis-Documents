import { useState } from 'react'
import { useUiStore } from './stores/uiStore'
import { Sidebar } from './components/Sidebar'
import { ImportModal } from './components/ImportModal'
import { DetailModal } from './components/DetailModal'
import { OrganizeView } from './components/OrganizeView'
import { FilesView } from './components/FilesView'
import { SearchView } from './components/SearchView'
import { PlatformView } from './components/PlatformView'
import { SubscriptionsView } from './components/SubscriptionsView'
import { SearchResults } from './components/SearchResults'
import { SettingsView } from './components/SettingsView'

export default function App(): React.ReactNode {
  const view = useUiStore((s) => s.view)
  const searchQuery = useUiStore((s) => s.searchQuery)

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        {searchQuery ? (
          <SearchResults />
        ) : view === 'files' ? (
          <FilesView />
        ) : view === 'organize' ? (
          <OrganizeView />
        ) : view === 'search' ? (
          <SearchView />
        ) : view === 'platform' ? (
          <PlatformView />
        ) : view === 'subscriptions' ? (
          <SubscriptionsView />
        ) : view === 'settings' ? (
          <SettingsView />
        ) : (
          <EmptyState />
        )}
      </main>
      <ImportModal />
      <DetailModal />
    </div>
  )
}

function EmptyState(): React.ReactNode {
  return <FirstRun />
}

function FirstRun(): React.ReactNode {
  const [importing, setImporting] = useState(false)

  const onImport = async (): Promise<void> => {
    setImporting(true)
    try {
      const picked = await window.oasis.files.pickDirectories()
      if (picked.length === 0) return
      await window.oasis.files.addWatchPaths(picked)
      useUiStore.getState().showToast(`已导入 ${picked.length} 个文件夹，正在自动索引`)
      useUiStore.getState().openDir(null)
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="empty-state">
      <div className="empty-wordmark">Oasis <span className="note">Documents</span></div>
      <p>你的数字资产中枢</p>
      <div className="empty-actions">
        <button type="button" className="btn primary" onClick={() => void onImport()} disabled={importing}>
          {importing ? '导入中…' : '导入本地文件夹'}
        </button>
      </div>
      <p style={{ fontSize: 12, color: 'var(--fg-faint)' }}>导入后文件自动索引，即可全文与语义检索</p>
    </div>
  )
}
