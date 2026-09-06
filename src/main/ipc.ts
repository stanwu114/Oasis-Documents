import { ipcMain, safeStorage, shell, BrowserWindow, dialog } from 'electron'
import { join } from 'node:path'
import { getDb } from './db'
import {
  scanAndHash,
  buildDuplicateGroups,
  listDuplicateGroups
} from './organizer/duplicates'
import { generateSuggestions, loadRules } from './organizer/rules'
import {
  executeSuggestions,
  revertBatch,
  listRecentBatches,
  trashFiles
} from './organizer/executor'
import { addWatch, removeWatch } from './indexer/watcher'
import { reindexPending, embeddingQueueSize } from './indexer/embedding-pipeline'
import { autoTagSmart, mergeTags } from './autotag'
import { classifyExt } from '../shared/classify'
import { isUnderRoot } from './path-boundary'
import { testProviderConnection } from './llm-providers'
import { getMediaParserConf, saveMediaParserConf, testMediaParser } from './platforms/external'
import { xhsSidecarStatus, enableBuiltinXhs, stopXhsSidecar, setBuiltinXhs } from './platforms/xhs-sidecar'
import { buildSystemStatus } from './status'
import { getImportProgress } from './import-progress'
import { persistEmbeddingSettings, hydrateEmbeddingSettings } from './credentials'
import { videoSidecar } from './video/sidecar'
import { searchByText, searchImagesByText, searchByImage, embedderStatus } from './search'
import { invalidateEmbedderCache } from './embedder'
import { modelStatuses, downloadModel } from './models/manager'
import { importLink, listPlugins } from './platforms'
import type { EmbeddingSettings, FileIndexStatus } from '../shared/ipc'

/* ================================================================
   IPC 通道注册 — 命名约定：<domain>:<action>
   ================================================================ */

export function registerIpc(): void {
  registerOrganizerIpc()
  registerFilesIpc()
  registerSettingsIpc()
  registerSearchIpc()
  registerModelIpc()
  registerPlatformIpc()
  registerImportIpc()
  registerNotesIpc()
  registerVideoIpc()
  registerStatusIpc()
  registerLlmIpc()
}

function win(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null
}

function safeParseTags(json: string | null | undefined): string[] {
  if (!json) return []
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

function safeParseMeta(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {}
  try {
    const v = JSON.parse(json)
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/* ---- 整理 ---- */
function registerOrganizerIpc(): void {
  ipcMain.handle('organizer:scan', async (_e, roots: string[]) => {
    const sender = win()
    await scanAndHash(roots, (scanned, current) => {
      sender?.webContents.send('organizer:progress', { scanned, current })
    })
    return buildDuplicateGroups()
  })

  ipcMain.handle('organizer:duplicates', (_e, status?: string) => listDuplicateGroups(status ?? 'pending'))

  ipcMain.handle('organizer:rules', () => loadRules())

  /* F04：结构化规则保存（JSON 形态写入 rule_yaml 字段，兼容既有解析） */
  ipcMain.handle('organizer:saveRule', (_e, rule: { id?: number; name: string; category?: string; pathPrefix?: string; nameContains?: string; action: 'move' | 'trash' | 'tag'; target?: string; tag?: string; enabled?: boolean }) => {
    const db = getDb()
    const yaml = JSON.stringify({
      name: rule.name,
      when: {
        ...(rule.category ? { mime: `${rule.category}/*` } : {}),
        ...(rule.pathPrefix ? { path_prefix: rule.pathPrefix } : {}),
        ...(rule.nameContains ? { name_matches: rule.nameContains } : {})
      },
      ...(rule.action === 'tag' ? { action: 'tag', tag: rule.tag ?? '' } : { action: rule.action }),
      suggest: rule.action === 'move' ? (rule.target ?? '~/Documents/归档') : rule.action === 'tag' ? (rule.tag ?? '') : 'trash'
    })
    const now = Date.now()
    if (rule.id) {
      db.prepare(`UPDATE organize_rules SET name = ?, rule_yaml = ?, updated_at = ? WHERE id = ?`).run(rule.name, yaml, now, rule.id)
      return rule.id
    }
    const info = db
      .prepare(`INSERT INTO organize_rules (name, enabled, priority, rule_yaml, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)`)
      .run(rule.name, rule.enabled === false ? 0 : 1, yaml, now, now)
    return Number(info.lastInsertRowid)
  })

  ipcMain.handle('organizer:deleteRule', (_e, id: number) => {
    getDb().prepare(`DELETE FROM organize_rules WHERE id = ?`).run(id)
  })

  /* F04：建议预览（源→目标、理由、冲突检测） */
  ipcMain.handle('organizer:listSuggestions', () => {
    const db = getDb()
    return db
      .prepare(`SELECT id, file_path, action, target_path, reason, status FROM organize_suggestions WHERE status = 'pending' ORDER BY created_at DESC LIMIT 500`)
      .all()
  })

  /* F04：逐项撤销（按单条操作日志恢复） */
  ipcMain.handle('organizer:revertItem', async (_e, logId: number) => {
    const { revertItem } = await import('./organizer/executor')
    return revertItem(logId)
  })

  ipcMain.handle('organizer:suggest', async (_e, paths: string[]) => generateSuggestions(paths))

  ipcMain.handle('organizer:execute', async (_e, ids: number[]) => executeSuggestions(ids))

  ipcMain.handle('organizer:trash', async (_e, paths: string[]) => trashFiles(paths))

  ipcMain.handle('organizer:revert', async (_e, batchId: string) => revertBatch(batchId))

  ipcMain.handle('organizer:batches', () => listRecentBatches())
}

/* ---- 文件 ---- */
function registerFilesIpc(): void {
  ipcMain.handle('files:getWatchPaths', () => {
    const db = getDb()
    return (db.prepare(`SELECT path FROM watch_paths WHERE enabled = 1`).all() as { path: string }[]).map((r) => r.path)
  })

  ipcMain.handle('files:pickDirectories', async (): Promise<string[]> => {
    const focused = win()
    const options: Electron.OpenDialogOptions = {
      title: '选择要监控的文件夹（可多选）',
      properties: ['openDirectory', 'multiSelections', 'createDirectory']
    }
    const res = focused ? await dialog.showOpenDialog(focused, options) : await dialog.showOpenDialog(options)
    return res.canceled ? [] : res.filePaths
  })

  ipcMain.handle('files:addWatchPaths', (_e, paths: string[]) => {
    const db = getDb()
    const insert = db.prepare(`INSERT OR IGNORE INTO watch_paths (path, created_at) VALUES (?, ?)`)
    for (const raw of paths) {
      const expanded = raw.replace(/^~(?=\/)/, process.env.HOME ?? '~')
      insert.run(expanded, Date.now())
      void addWatch(expanded)
    }
  })

  ipcMain.handle('files:addWatchPath', (_e, path: string) => {
    const expanded = path.replace(/^~(?=\/)/, process.env.HOME ?? '~')
    getDb().prepare(`INSERT OR IGNORE INTO watch_paths (path, created_at) VALUES (?, ?)`).run(expanded, Date.now())
    void addWatch(expanded)
  })

  ipcMain.handle('files:removeWatchPath', (_e, path: string) => {
    getDb().prepare(`DELETE FROM watch_paths WHERE path = ?`).run(path)
    void removeWatch(path)
  })

  ipcMain.handle('files:getStatus', (): FileIndexStatus => {
    const db = getDb()
    const row = db.prepare(`SELECT COUNT(*) as total FROM contents`).get() as { total: number }
    const indexed = db.prepare(`SELECT COUNT(*) as n FROM contents WHERE indexed_at IS NOT NULL`).get() as { n: number }
    const pending = db.prepare(`SELECT COUNT(*) as n FROM contents WHERE needs_reindex = 1`).get() as { n: number }
    return {
      totalFiles: row.total,
      indexedFiles: indexed.n,
      pendingFiles: pending.n,
      isScanning: getImportProgress().phase === 'indexing' || getImportProgress().phase === 'embedding',
      lastScanAt: null
    }
  })

  ipcMain.handle('files:reindex', () => reindexPending())

  ipcMain.handle('files:embedQueue', () => embeddingQueueSize())

  ipcMain.handle('files:listSubDirs', async () => {
    const db = getDb()
    const roots = (db.prepare(`SELECT path FROM watch_paths WHERE enabled = 1`).all() as { path: string }[]).map(
      (r) => r.path
    )
    const { readdir } = await import('node:fs/promises')
    const { basename } = await import('node:path')
    return Promise.all(
      roots.map(async (watchPath) => {
        let subDirs: { name: string; path: string }[] = []
        try {
          const entries = await readdir(watchPath, { withFileTypes: true })
          subDirs = entries
            .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
            .map((e) => ({ name: e.name, path: `${watchPath}/${e.name}` }))
            .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
        } catch {
          /* 目录不可读 */
        }
        return { watchPath, name: basename(watchPath), subDirs }
      })
    )
  })

  ipcMain.handle('files:renameDir', async (_e, oldPath: string, newName: string) => {
    const safeName = newName.trim().replace(/[/\\:]/g, '')
    if (!safeName || safeName === '.' || safeName === '..') throw new Error('非法文件夹名')
    const newPath = `${oldPath.slice(0, oldPath.lastIndexOf('/'))}/${safeName}`
    if (newPath === oldPath) return { newPath, movedCount: 0 }

    /* 1) 真实重命名（fs.rename 原子操作，同卷） */
    const { rename } = await import('node:fs/promises')
    await rename(oldPath, newPath)

    /* 2) 同步索引：该目录下所有 contents 的 source_path 前缀替换 */
    const db = getDb()
    const info = db
      .prepare(
        `UPDATE contents
         SET source_path = ? || substr(source_path, length(?) + 1), updated_at = ?
         WHERE substr(source_path, 1, length(?)) = ? AND substr(source_path, length(?) + 1, 1) IN ('/', '')`
      )
      .run(newPath, oldPath, Date.now(), oldPath, oldPath, oldPath)

    /* 3) 若是监控目录本身：更新 watch_paths 并重启 watcher */
    const wp = db.prepare(`UPDATE watch_paths SET path = ? WHERE path = ?`).run(newPath, oldPath)
    if (wp.changes > 0) {
      await removeWatch(oldPath)
      void addWatch(newPath)
    }

    return { newPath, movedCount: info.changes }
  })

  /* 移除监控文件夹：取消监控 + 清索引，不动磁盘文件 */
  ipcMain.handle('files:removeWatchDir', async (_e, path: string) => {
    const db = getDb()
    await removeWatch(path)

    /* 先中止进行中的索引批次，防止删除后旧批次把文件插回来 */
    const { abortRunningIndexBatches } = await import('./indexer/pipeline')
    abortRunningIndexBatches()

    /* R02：目录边界精确匹配——前缀 LIKE 会把 work 误清成 work-old；
       仅匹配 path 本身或 path + '/' 开头的记录 */
    const underRoot = (p: string | null): boolean => isUnderRoot(p, path)

    /* 先取缩略图路径用于清理文件 */
    const localRows = (
      db.prepare(`SELECT id, source_path, thumbnail_path FROM contents WHERE source_path IS NOT NULL`).all() as {
        id: string
        source_path: string
        thumbnail_path: string | null
      }[]
    ).filter((r) => underRoot(r.source_path))
    const thumbs = localRows.map((r) => r.thumbnail_path).filter((t): t is string => Boolean(t))

    /* N05：统一级联删除（FTS + 向量 + 笔记），不再裸 DELETE */
    const { deleteContentCascade } = await import('./indexer/pipeline')
    for (const r of localRows) deleteContentCascade(r.id)

    /* R07：哈希缓存与重复组同步清理（同一边界规则） */
    const hashRows = db.prepare(`SELECT path FROM file_hashes`).all() as { path: string }[]
    const delHash = db.prepare(`DELETE FROM file_hashes WHERE path = ?`)
    for (const h of hashRows) if (underRoot(h.path)) delHash.run(h.path)
    db.prepare(`DELETE FROM duplicate_groups WHERE status = 'pending'`).run()

    db.prepare(`DELETE FROM watch_paths WHERE path = ?`).run(path)

    /* 清理缩略图文件（尽力而为） */
    const { unlink } = await import('node:fs/promises')
    for (const t of thumbs) {
      void unlink(t).catch(() => {})
    }
    return { removedContents: localRows.length }
  })

  ipcMain.handle('files:getDetail', (_e, id: string) => {
    const db = getDb()
    const row = db
      .prepare(
        `SELECT id, type, title, content, source_path, url, platform, mime_type, file_size,
                thumbnail_path, ocr_text, tags, meta, created_at, updated_at, indexed_at
         FROM contents WHERE id = ?`
      )
      .get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      ...row,
      tags: safeParseTags(row.tags as string),
      meta: safeParseMeta(row.meta as string)
    }
  })

  ipcMain.handle('files:getReading', () => {
    /* 订阅模块已移除:普通收藏直接走 getDetail */
    return null
  })

  ipcMain.handle('files:reveal', (_e, path: string) => {
    shell.showItemInFolder(path)
  })

  ipcMain.handle('files:list', async (_e, _dir?: string, opts?: { offset?: number; limit?: number; dir?: string; category?: string }) => {
    const db = getDb()
    const offset = Math.max(0, opts?.offset ?? 0)
    const limit = Math.min(Math.max(opts?.limit ?? 500, 1), 10000) /* 一次性全量展示 */

    /* R22：目录/分类在 SQL 里先过滤再分页——前端过滤分页数据会产生假空列表 */
    /* 两套过滤范围：
       scopeWhere —— 目录范围（total 与各分类计数永远按此统计，
                     切换分类 tab 不改变「全部」与各分类的数字）；
       rowWhere   —— 列表行过滤（目录 + 当前分类），只影响返回的行 */
    const scope: string[] = [`source_path IS NOT NULL`]
    const scopeParams: unknown[] = []
    if (opts?.dir) {
      scope.push(`(source_path = ? OR source_path LIKE ? ESCAPE '\\')`)
      const esc = opts.dir.replace(/([%_\\])/g, '\\$1')
      scopeParams.push(opts.dir, `${esc}/%`)
    }
    const scopeSql = `WHERE ${scope.join(' AND ')}`

    const row: string[] = [...scope]
    const rowParams: unknown[] = [...scopeParams]
    if (opts?.category) {
      row.push(`type = ?`)
      rowParams.push(opts.category)
    }
    const rowSql = `WHERE ${row.join(' AND ')}`

    /* 「全部」= 目录范围内全部文件（与当前分类 tab 无关） */
    const total = (db.prepare(`SELECT COUNT(*) as n FROM contents ${scopeSql}`).get(...(scopeParams as never[])) as { n: number }).n
    /* 各分类计数：同样只按目录范围；数组转 Record（前端按 counts[type] 取值） */
    const countRows = (
      db
        .prepare(`SELECT type, COUNT(*) as n FROM contents ${scopeSql} GROUP BY type`)
        .all(...(scopeParams as never[])) as { type: string; n: number }[]
    ).filter((r) => r.type !== 'webpage' && r.type !== 'note')
    const counts: Record<string, number> = Object.fromEntries(countRows.map((r) => [r.type, r.n]))
    const rows = db
      .prepare(
        `SELECT id, type, title, source_path, thumbnail_path, url, mime_type, file_size, created_at
         FROM contents ${rowSql}
         ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .all(...([...rowParams, limit, offset] as never[])) as {
      id: string
      type: string
      title: string
      source_path: string | null
      thumbnail_path: string | null
      url: string | null
      mime_type: string | null
      file_size: number | null
      created_at: number
    }[]
    /* 补充文件全名与最后修改时间（读文件系统 mtime） */
    const { stat } = await import('node:fs/promises')
    const { basename } = await import('node:path')
    const out: Record<string, unknown>[] = []
    for (const r of rows) {
      let mtime = r.created_at
      if (r.source_path) {
        try {
          mtime = (await stat(r.source_path)).mtimeMs
        } catch {
          /* 文件已移动/删除，退化为入库时间 */
        }
      }
      const ext = r.source_path ? (r.source_path.split('.').pop() ?? '').toLowerCase() : ''
      out.push({
        ...r,
        /* 本地文件按扩展名分类（source_path 非空，webpage 已被 SQL 过滤） */
        category: classifyExt(ext),
        full_name: r.source_path ? basename(r.source_path) : r.title,
        ext,
        modified_at: mtime
      })
    }
    return { rows: out, total, hasMore: offset + out.length < total, counts }
  })
}

/* ---- 检索 ---- */
function registerSearchIpc(): void {
  /* 以文搜文:搜索对象仅文档(缺省 'document',传 'all' 可显式全量) */
  ipcMain.handle(
    'search:query',
    (_e, text: string, opts?: { limit?: number; filters?: string[]; type?: 'all' | 'document' }) =>
      searchByText(text, { limit: opts?.limit, type: opts?.type ?? 'document' })
  )

  ipcMain.handle('search:queryImage', (_e, imagePath: string, opts?: { limit?: number }) =>
    searchByImage(imagePath, opts?.limit)
  )

  ipcMain.handle('search:imagesByText', (_e, text: string, limit?: number) =>
    searchImagesByText(text, limit)
  )

  ipcMain.handle('search:embedderStatus', () => embedderStatus())

  /* 以图搜图：查询图复制进媒体目录（raw 协议白名单内），返回可显示 URL */
  ipcMain.handle('search:stageQueryImage', async (_e, srcPath: string): Promise<string | null> => {
    try {
      const { copyFile, mkdir } = await import('node:fs/promises')
      const { createHash } = await import('node:crypto')
      const { getMediaDir } = await import('./dataLocation')
      const dir = join(getMediaDir(), 'search-uploads')
      await mkdir(dir, { recursive: true })
      const { readFile } = await import('node:fs/promises')
      const buf = await readFile(srcPath)
      const name = `${createHash('sha1').update(buf).digest('hex').slice(0, 16)}${srcPath.slice(srcPath.lastIndexOf('.'))}`
      const dest = join(dir, name)
      await copyFile(srcPath, dest)
      return `oasis-media://media/search-uploads/${name}`
    } catch {
      return null
    }
  })
}

/* ---- 系统状态页 ---- */
function registerStatusIpc(): void {
  ipcMain.handle('status:overview', () => buildSystemStatus())
}

/* ---- 在线模型服务商接入:测试连通 + 拉取模型列表 ---- */
function registerLlmIpc(): void {
  ipcMain.handle('llm:testProvider', (_e, input: { provider: 'bailian' | 'zhipu' | 'custom'; apiKey: string; baseUrl?: string }) =>
    testProviderConnection(input)
  )
}

/* ---- 导入进度（事件推送 + 轮询双通道，UI 收敛不依赖单点） ---- */
function registerImportIpc(): void {
  ipcMain.handle('import:status', () => getImportProgress())
}

/* ---- Newsletter / L3 平台账号 ---- */
/* ---- 12.2：索引状态诊断 ---- */
/* ---- 视频检索（SentrySearch sidecar） ---- */
function registerVideoIpc(): void {
  ipcMain.handle('video:init', async (_e, params: { backend: 'qwen-cloud' | 'gemini' | 'local'; apiKey?: string; model?: string }) => {
    return videoSidecar.init(params)
  })

  ipcMain.handle('video:index', async (_e, params: { paths: string[]; chunkDuration?: number; overlap?: number }) => {
    return videoSidecar.index(params)
  })

  ipcMain.handle('video:search', async (_e, query: string, limit?: number) => {
    return videoSidecar.search(query, limit ?? 10)
  })

  ipcMain.handle('video:stats', () => videoSidecar.stats())

  ipcMain.handle('video:remove', (_e, sourceFile: string) => videoSidecar.remove(sourceFile))
}

/* ---- 模型 ---- */
function registerModelIpc(): void {
  ipcMain.handle('models:status', () => modelStatuses())

  ipcMain.handle('models:download', async (_e, name: string) => {
    const sender = win()
    await downloadModel(name, (s) => sender?.webContents.send('model:progress', s))
    /* 模型就位后立即补扫历史待嵌入内容（无需重启应用） */
    invalidateEmbedderCache()
    if (name === 'clip-zh') {
      /* 中文 CLIP 就位:图片向量空间即将切换(旧英文向量不兼容),
         全部图片标记待重嵌——写入路径 ensureVectorSpace 会 drop 旧表 */
      getDb().prepare(`UPDATE contents SET needs_reindex = 1 WHERE type = 'image'`).run()
    }
    const queued = reindexPending()
    if (queued > 0) console.log(`[embed-pipeline] 模型就绪，补扫 ${queued} 条`)
  })
}

/* ---- 平台收藏（L1 链接导入） ---- */
function registerPlatformIpc(): void {
  ipcMain.handle('platform:importLink', async (_e, url: string) => importLink(url))

  ipcMain.handle('platform:listPlugins', () => listPlugins())

  ipcMain.handle('platform:listContents', () => {
    const db = getDb()
    const rows = db
      .prepare(
        `SELECT id, title, url, platform, thumbnail_path, tags,
                substr(content, 1, 300) as snippet, created_at,
                json_extract(meta, '$.imageUrls') as image_urls
         FROM contents WHERE type = 'webpage' ORDER BY created_at DESC LIMIT 200`
      )
      .all() as unknown as Record<string, unknown>[]
    return rows.map((r) => ({
      ...r,
      tags: safeParseTags(r.tags as string),
      image_urls: safeParseTags(r.image_urls as string)
    }))
  })

  /* 删除收藏(仅 webpage 类型):SQLite 行 + 笔记 + FTS + 两张向量表级联清理,
     本地缩略图文件一并删除(仍被其他收藏引用时保留) */
  ipcMain.handle('platform:remove', async (_e, id: string): Promise<{ removed: boolean }> => {
    const db = getDb()
    const row = db
      .prepare(`SELECT id, thumbnail_path FROM contents WHERE id = ? AND type = 'webpage'`)
      .get(id) as { id: string; thumbnail_path: string | null } | undefined
    if (!row) return { removed: false }

    const { deleteContentCascade } = await import('./indexer/pipeline')
    deleteContentCascade(id)

    if (row.thumbnail_path) {
      /* 缩略图按图片 URL 哈希命名,多条收藏共用同一图时不删文件 */
      const shared = (
        db.prepare(`SELECT COUNT(*) AS n FROM contents WHERE thumbnail_path = ?`).get(row.thumbnail_path) as { n: number }
      ).n
      if (shared === 0) {
        const { unlink } = await import('node:fs/promises')
        void unlink(row.thumbnail_path).catch(() => {})
      }
    }
    return { removed: true }
  })

  /* 存量内容补打 AI 标签（在线文本模型优先，本地兜底） */
  /* 外部解析服务(可选:XHS-Downloader / Douyin_TikTok_Download_API) */
  ipcMain.handle('mediaParser:get', () => getMediaParserConf())
  ipcMain.handle('mediaParser:set', (_e, conf: { xhs?: string; douyin?: string }) => saveMediaParserConf(conf))
  ipcMain.handle('mediaParser:test', (_e, base: string) => testMediaParser(base))
  ipcMain.handle('mediaParser:builtinStatus', () => xhsSidecarStatus())
  ipcMain.handle('mediaParser:builtinEnable', async (_e) => enableBuiltinXhs())
  ipcMain.handle('mediaParser:builtinDisable', () => {
    stopXhsSidecar()
    setBuiltinXhs(false)
  })

  /* 重新抓取图文(存量收藏图片未落地/链接内容更新时) */
  ipcMain.handle('platform:refresh', async (_e, id: string) => {
    const { refreshPlatformContent } = await import('./platforms')
    return refreshPlatformContent(id)
  })

  ipcMain.handle('platform:retag', async () => {
    const db = getDb()
    const rows = db
      .prepare(`SELECT id, title, content, tags FROM contents WHERE type = 'webpage'`)
      .all() as { id: string; title: string; content: string; tags: string }[]
    const update = db.prepare(`UPDATE contents SET tags = ?, updated_at = ? WHERE id = ?`)
    let count = 0
    for (const r of rows) {
      const ai = await autoTagSmart(r.title, r.content)
      const platformTags = safeParseTags(r.tags)
      const merged = mergeTags(ai.tags, platformTags)
      if (merged.length > 0) {
        update.run(JSON.stringify(merged), Date.now(), r.id)
        count++
      }
    }
    return count
  })
}

/* ---- 订阅时间线（RSS/Atom） ---- */
/* ---- F05：批量导入导出 ---- */
/* ---- F03：笔记与划线 ---- */
function registerNotesIpc(): void {
  ipcMain.handle('notes:list', (_e, contentId: string) => {
    return getDb()
      .prepare(`SELECT id, content_id, anchor_text, note, color, created_at, updated_at FROM notes WHERE content_id = ? ORDER BY created_at DESC`)
      .all(contentId)
  })

  ipcMain.handle('notes:add', (_e, contentId: string, anchorText: string, note: string, color?: string) => {
    const now = Date.now()
    const info = getDb()
      .prepare(`INSERT INTO notes (content_id, anchor_text, note, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(contentId, anchorText.slice(0, 500), note.slice(0, 2000), color ?? 'accent', now, now)
    return info.lastInsertRowid
  })

  ipcMain.handle('notes:update', (_e, id: number, note: string) => {
    getDb().prepare(`UPDATE notes SET note = ?, updated_at = ? WHERE id = ?`).run(note.slice(0, 2000), Date.now(), id)
  })

  ipcMain.handle('notes:remove', (_e, id: number) => {
    getDb().prepare(`DELETE FROM notes WHERE id = ?`).run(id)
  })
}

/* ---- 设置（R26：凭据逻辑见 credentials.ts，配置不再保存明文 Key） ---- */
function registerSettingsIpc(): void {
  ipcMain.handle('settings:getEmbedding', (): EmbeddingSettings => {
    const db = getDb()
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'embedding'`).get() as
      | { value: string }
      | undefined
    if (!row) return defaultEmbeddingSettings()
    /* 存量配置迁移：补齐后来新增的 onlineLlm / onlineMultimodal */
    const parsed = { ...defaultEmbeddingSettings(), ...(JSON.parse(row.value) as EmbeddingSettings) }
    parsed.onlineLlm = parsed.onlineLlm ?? defaultEmbeddingSettings().onlineLlm
    parsed.onlineMultimodal = parsed.onlineMultimodal ?? defaultEmbeddingSettings().onlineMultimodal
    return hydrateEmbeddingSettings(parsed)
  })

  ipcMain.handle('settings:setEmbedding', (_e, settings: EmbeddingSettings) => {
    persistEmbeddingSettings(settings)
    /* 嵌入配置变更后清缓存（下次调用按新配置构建） */
    invalidateEmbedderCache()
  })

  /* API Key 走 safeStorage 加密（macOS Keychain） */
  ipcMain.handle('settings:getEncrypted', (_e, key: string): string | null => {
    const db = getDb()
    const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined
    if (!row) return null
    if (!safeStorage.isEncryptionAvailable()) return row.value
    try {
      return safeStorage.decryptString(Buffer.from(row.value, 'base64'))
    } catch {
      return null
    }
  })

  ipcMain.handle('settings:setEncrypted', (_e, key: string, value: string) => {
    const db = getDb()
    const stored = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(value).toString('base64')
      : value
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, stored)
  })
}

function defaultEmbeddingSettings(): EmbeddingSettings {
  return {
    defaultProvider: 'local',
    local: { clipModelPath: '', bgeModelPath: '' },
    providers: {
      openai: { enabled: false, apiKey: '', model: 'text-embedding-3-small' },
      zhipu: { enabled: false, apiKey: '', model: 'embedding-3' },
      qwen: { enabled: false, apiKey: '', model: 'text-embedding-v3' },
      custom: { enabled: false, apiKey: '', model: '', baseUrl: '', dimensions: 0 }
    },
    onlineLlm: { enabled: false, provider: 'zhipu', apiKey: '', model: 'glm-4-flash' },
    onlineMultimodal: { enabled: false, provider: 'qwen', apiKey: '', model: 'qwen-vl-plus' },
    advanced: {
      autoReindexOnModelChange: false,
      imageSearchStrategy: 'clip-only',
      batchSize: 32,
      onlineConcurrency: 5,
      timeoutMs: 30000
    }
  }
}
