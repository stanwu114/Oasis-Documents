import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { OasisAPI } from '../shared/ipc'

const api: OasisAPI = {
  search: {
    query: (text, options) => ipcRenderer.invoke('search:query', text, options),
    queryImage: (imagePath, options) => ipcRenderer.invoke('search:queryImage', imagePath, options),
    imagesByText: (text, limit) => ipcRenderer.invoke('search:imagesByText', text, limit),
    stageQueryImage: (path) => ipcRenderer.invoke('search:stageQueryImage', path)
  },
  video: {
    init: (params) => ipcRenderer.invoke('video:init', params),
    index: (params) => ipcRenderer.invoke('video:index', params),
    search: (query, limit) => ipcRenderer.invoke('video:search', query, limit),
    stats: () => ipcRenderer.invoke('video:stats'),
    remove: (sourceFile) => ipcRenderer.invoke('video:remove', sourceFile),
    onProgress: (cb) => {
      const listener = (_e: unknown, p: unknown): void => cb(p as never)
      ipcRenderer.on('video:progress', listener)
      return () => ipcRenderer.removeListener('video:progress', listener)
    }
  },
  files: {
    list: (dir, opts) => ipcRenderer.invoke('files:list', dir, opts),
    getStatus: () => ipcRenderer.invoke('files:getStatus'),
    pickDirectories: () => ipcRenderer.invoke('files:pickDirectories'),
    addWatchPath: (path) => ipcRenderer.invoke('files:addWatchPath', path),
    addWatchPaths: (paths) => ipcRenderer.invoke('files:addWatchPaths', paths),
    removeWatchPath: (path) => ipcRenderer.invoke('files:removeWatchPath', path),
    getWatchPaths: () => ipcRenderer.invoke('files:getWatchPaths'),
    reindex: () => ipcRenderer.invoke('files:reindex'),
    reveal: (path) => {
      void ipcRenderer.invoke('files:reveal', path)
    },
    getDetail: (id) => ipcRenderer.invoke('files:getDetail', id),
    getReading: (id) => ipcRenderer.invoke('files:getReading', id),
    listSubDirs: () => ipcRenderer.invoke('files:listSubDirs'),
    renameDir: (oldPath, newName) => ipcRenderer.invoke('files:renameDir', oldPath, newName),
    removeWatchDir: (path) => ipcRenderer.invoke('files:removeWatchDir', path)
  },
  organizer: {
    scan: (roots) => ipcRenderer.invoke('organizer:scan', roots),
    duplicates: (status) => ipcRenderer.invoke('organizer:duplicates', status),
    rules: () => ipcRenderer.invoke('organizer:rules'),
    saveRule: (rule) => ipcRenderer.invoke('organizer:saveRule', rule),
    deleteRule: (id) => ipcRenderer.invoke('organizer:deleteRule', id),
    listSuggestions: () => ipcRenderer.invoke('organizer:listSuggestions'),
    revertItem: (logId) => ipcRenderer.invoke('organizer:revertItem', logId),
    suggest: (paths) => ipcRenderer.invoke('organizer:suggest', paths),
    execute: (ids) => ipcRenderer.invoke('organizer:execute', ids),
    trash: (paths) => ipcRenderer.invoke('organizer:trash', paths),
    revert: (batchId) => ipcRenderer.invoke('organizer:revert', batchId),
    batches: () => ipcRenderer.invoke('organizer:batches'),
    onProgress: (cb) => {
      const listener = (_e: unknown, p: unknown): void => cb(p as never)
      ipcRenderer.on('organizer:progress', listener)
      return () => ipcRenderer.removeListener('organizer:progress', listener)
    }
  },
  settings: {
    getEmbedding: () => ipcRenderer.invoke('settings:getEmbedding'),
    setEmbedding: (settings) => ipcRenderer.invoke('settings:setEmbedding', settings),
    getEncrypted: (key) => ipcRenderer.invoke('settings:getEncrypted', key),
    setEncrypted: (key, value) => ipcRenderer.invoke('settings:setEncrypted', key, value)
  },
  platform: {
    importLink: (url) => ipcRenderer.invoke('platform:importLink', url),
    listPlugins: () => ipcRenderer.invoke('platform:listPlugins'),
    listContents: () => ipcRenderer.invoke('platform:listContents'),
    retag: () => ipcRenderer.invoke('platform:retag')
  },
  subs: {
    add: (url) => ipcRenderer.invoke('subs:add', url),
    list: () => ipcRenderer.invoke('subs:list'),
    remove: (id) => ipcRenderer.invoke('subs:remove', id),
    refresh: (id) => ipcRenderer.invoke('subs:refresh', id),
    items: (opts) => ipcRenderer.invoke('subs:items', opts),
    markRead: (itemId, read) => ipcRenderer.invoke('subs:markRead', itemId, read),
    star: (itemId, starred) => ipcRenderer.invoke('subs:star', itemId, starred)
  },
  notes: {
    list: (contentId) => ipcRenderer.invoke('notes:list', contentId),
    add: (contentId, anchorText, note, color) => ipcRenderer.invoke('notes:add', contentId, anchorText, note, color),
    update: (id, note) => ipcRenderer.invoke('notes:update', id, note),
    remove: (id) => ipcRenderer.invoke('notes:remove', id)
  },
  io: {
    importBookmarks: (html) => ipcRenderer.invoke('io:importBookmarks', html),
    importOpml: (xml) => ipcRenderer.invoke('io:importOpml', xml),
    importJson: (json) => ipcRenderer.invoke('io:importJson', json),
    exportJson: () => ipcRenderer.invoke('io:exportJson'),
    pickOpenFile: (extensions) => ipcRenderer.invoke('io:pickOpenFile', extensions),
    pickSaveFile: (defaultName) => ipcRenderer.invoke('io:pickSaveFile', defaultName),
    readFile: (path) => ipcRenderer.invoke('io:readFile', path),
    writeFile: (path, content) => ipcRenderer.invoke('io:writeFile', path, content)
  },
  newsletter: {
    conf: () => ipcRenderer.invoke('newsletter:conf'),
    save: (input) => ipcRenderer.invoke('newsletter:save', input),
    sync: () => ipcRenderer.invoke('newsletter:sync')
  },
  accounts: {
    list: () => ipcRenderer.invoke('accounts:list'),
    login: (id) => ipcRenderer.invoke('accounts:login', id),
    subscribeMp: (name, base) => ipcRenderer.invoke('accounts:subscribeMp', name, base)
  },
  diag: {
    indexStats: () => ipcRenderer.invoke('diag:indexStats')
  },
  importStatus: () => ipcRenderer.invoke('import:status'),
  models: {
    status: () => ipcRenderer.invoke('models:status'),
    download: (name) => ipcRenderer.invoke('models:download', name)
  },
  on: {
    indexProgress: (cb) => {
      const listener = (_e: unknown, status: unknown): void => cb(status as never)
      ipcRenderer.on('index:progress', listener)
      return () => ipcRenderer.removeListener('index:progress', listener)
    },
    modelProgress: (cb) => {
      const listener = (_e: unknown, status: unknown): void => cb(status as never)
      ipcRenderer.on('model:progress', listener)
      return () => ipcRenderer.removeListener('model:progress', listener)
    },
    toast: (cb) => {
      const listener = (_e: unknown, msg: string, kind: 'info' | 'error'): void => cb(msg, kind)
      ipcRenderer.on('app:toast', listener)
      return () => ipcRenderer.removeListener('app:toast', listener)
    },
    importProgress: (cb) => {
      const listener = (_e: unknown, p: unknown): void => cb(p as never)
      ipcRenderer.on('import:progress', listener)
      return () => ipcRenderer.removeListener('import:progress', listener)
    }
  }
}

contextBridge.exposeInMainWorld('oasis', api)

/* Electron 43 移除了 File.path，拖拽文件取路径必须走 webUtils */
contextBridge.exposeInMainWorld('oasisWebUtils', {
  getPathForFile: (file: File): string => webUtils.getPathForFile(file)
})
