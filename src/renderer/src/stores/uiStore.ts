import { create } from 'zustand'
import type { SearchResult, ImportProgress } from '../../../shared/ipc'

export type Theme = 'light' | 'dark'
export type View = 'home' | 'files' | 'organize' | 'search' | 'platform' | 'subscriptions' | 'settings'

interface UiState {
  view: View
  theme: Theme
  searchQuery: string
  searchResults: SearchResult[]
  toast: string | null
  toastKind: 'info' | 'error'
  /** 我的文件：当前过滤的目录（null = 全部） */
  currentDir: string | null
  /** F01/F03：详情/阅读模态目标 id（null 关闭） */
  detailId: string | null
  /** 导入会话进度（弹窗隐藏后侧栏文件夹仍实时显示） */
  importProgress: ImportProgress | null
  /** 导入完成报告（保留至用户点「完成」关闭） */
  importDoneReport: ImportProgress | null
  /** 导入进度弹窗是否被用户隐藏（点胶囊回弹） */
  importModalHidden: boolean
  /** 内容数据版本：删除/导入完成时递增，订阅它的视图自动重新拉取 */
  contentsVersion: number

  setView(v: View): void
  openDir(path: string | null): void
  openDetail(id: string | null): void
  setImportProgress(p: ImportProgress | null): void
  setImportDoneReport(p: ImportProgress | null): void
  setImportModalHidden(hidden: boolean): void
  bumpContents(): void
  setSearch(q: string, results: SearchResult[]): void
  toggleTheme(): void
  showToast(msg: string, kind?: 'info' | 'error'): void
}

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark')
  localStorage.setItem('oasis-docs.theme', theme)
}

function initialTheme(): Theme {
  const saved = localStorage.getItem('oasis-docs.theme')
  if (saved === 'light' || saved === 'dark') return saved
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export const useUiStore = create<UiState>((set, get) => ({
  view: 'home',
  theme: initialTheme(),
  searchQuery: '',
  searchResults: [],
  toast: null,
  toastKind: 'info',
  currentDir: null,
  detailId: null,
  importProgress: null,
  importDoneReport: null,
  importModalHidden: false,
  contentsVersion: 0,

  setView: (v) => set({ view: v }),
  openDir: (path) => set({ currentDir: path, view: 'files' }),
  openDetail: (id) => set({ detailId: id }),
  setImportProgress: (p) => set({ importProgress: p }),
  setImportDoneReport: (p) => set({ importDoneReport: p }),
  setImportModalHidden: (hidden) => set({ importModalHidden: hidden }),
  bumpContents: () => set((s) => ({ contentsVersion: s.contentsVersion + 1 })),
  setSearch: (q, results) => set({ searchQuery: q, searchResults: results }),

  toggleTheme: () => {
    const next: Theme = get().theme === 'dark' ? 'light' : 'dark'
    applyTheme(next)
    set({ theme: next })
  },

  showToast: (msg, kind = 'info') => {
    set({ toast: msg, toastKind: kind })
    window.setTimeout(() => {
      if (get().toast === msg) set({ toast: null })
    }, kind === 'error' ? 5000 : 2600)
  }
}))

applyTheme(useUiStore.getState().theme)
