import { ipcMain, safeStorage, shell, BrowserWindow, dialog } from 'electron'
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
import { getNewsletterConf, saveNewsletterConf, syncNewsletter } from './newsletter'
import { openPlatformLogin, subscribeWechatMp, accountActivity } from './platforms/accounts'
import { autoTagSmart, mergeTags } from './autotag'
import { classifyExt } from '../shared/classify'
import { isUnderRoot } from './path-boundary'
import { getImportProgress } from './import-progress'
import { persistEmbeddingSettings, hydrateEmbeddingSettings } from './credentials'
import * as ioModule from './io'
import { videoSidecar } from './video/sidecar'
import { searchByText, searchImagesByText, searchByImage, embedderStatus } from './search'
import { invalidateEmbedderCache, embedderReadiness } from './embedder'
import { modelStatuses, downloadModel } from './models/manager'
import { importLink, listPlugins } from './platforms'
import { addSubscription, refreshSubscription, refreshAll } from './subscriptions/rss'
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
  registerSubsIpc()
  registerImportIpc()
  registerNotesIpc()
  registerIoIpc()
  registerDiagnosticsIpc()
  registerNewsletterIpc()
  registerVideoIpc()
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
      isScanning: getImportProgress().phase === 'indexing',
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

  ipcMain.handle('files:getReading', (_e, id: string) => {
    const db = getDb()
    /* feed: 前缀 → 订阅条目阅读详情 */
    if (id.startsWith('feed:')) {
      const row = db
        .prepare(
          `SELECT f.id AS fid, f.title, f.summary AS content, f.url, f.published_at, s.title AS sub_title
           FROM feed_items f JOIN subscriptions s ON s.id = f.subscription_id WHERE f.id = ?`
        )
        .get(id.slice(5)) as
        | { fid: string; title: string; content: string; url: string; published_at: number; sub_title: string }
        | undefined
      if (!row) return null
      return {
        id,
        type: 'webpage',
        title: row.title,
        content: row.content,
        url: row.url,
        platform: `rss:${row.sub_title}`,
        tags: [],
        created_at: row.published_at,
        content_id: row.fid
      }
    }
    return null /* 普通收藏直接走 getDetail */
  })

  ipcMain.handle('files:reveal', (_e, path: string) => {
    shell.showItemInFolder(path)
  })

  ipcMain.handle('files:list', async (_e, _dir?: string, opts?: { offset?: number; limit?: number; dir?: string; category?: string }) => {
    const db = getDb()
    const offset = Math.max(0, opts?.offset ?? 0)
    const limit = Math.min(Math.max(opts?.limit ?? 500, 1), 2000)

    /* R22：目录/分类在 SQL 里先过滤再分页——前端过滤分页数据会产生假空列表 */
    const where: string[] = [`source_path IS NOT NULL`]
    const params: unknown[] = []
    if (opts?.dir) {
      where.push(`(source_path = ? OR source_path LIKE ? ESCAPE '\\')`)
      const esc = opts.dir.replace(/([%_\\])/g, '\\$1')
      params.push(opts.dir, `${esc}/%`)
    }
    if (opts?.category) {
      where.push(`type = ?`)
      params.push(opts.category)
    }
    const whereSql = `WHERE ${where.join(' AND ')}`

    const total = (db.prepare(`SELECT COUNT(*) as n FROM contents ${whereSql}`).get(...(params as never[])) as { n: number }).n
    const counts = opts?.dir
      ? (db
          .prepare(`SELECT type, COUNT(*) as n FROM contents ${whereSql} GROUP BY type`)
          .all(...(params as never[])) as { type: string; n: number }[])
      : (db.prepare(`SELECT type, COUNT(*) as n FROM contents WHERE source_path IS NOT NULL GROUP BY type`).all() as {
          type: string
          n: number
        }[])
    const rows = db
      .prepare(
        `SELECT id, type, title, source_path, thumbnail_path, url, mime_type, file_size, created_at
         FROM contents ${whereSql}
         ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .all(...([...params, limit, offset] as never[])) as {
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
  ipcMain.handle('search:query', (_e, text: string, opts?: { limit?: number; filters?: string[] }) =>
    searchByText(text, { limit: opts?.limit, type: 'all' })
  )

  ipcMain.handle('search:queryImage', (_e, imagePath: string, opts?: { limit?: number }) =>
    searchByImage(imagePath, opts?.limit)
  )

  ipcMain.handle('search:imagesByText', (_e, text: string, limit?: number) =>
    searchImagesByText(text, limit)
  )

  ipcMain.handle('search:embedderStatus', () => embedderStatus())
}

/* ---- 导入进度（事件推送 + 轮询双通道，UI 收敛不依赖单点） ---- */
function registerImportIpc(): void {
  ipcMain.handle('import:status', () => getImportProgress())
}

/* ---- Newsletter / L3 平台账号 ---- */
function registerNewsletterIpc(): void {
  ipcMain.handle('newsletter:conf', () => getNewsletterConf())
  ipcMain.handle('newsletter:save', (_e, input: Parameters<typeof saveNewsletterConf>[0]) => saveNewsletterConf(input))
  ipcMain.handle('newsletter:sync', async () => syncNewsletter())

  ipcMain.handle('accounts:list', () => accountActivity())
  ipcMain.handle('accounts:login', (_e, id: string) => openPlatformLogin(id))
  ipcMain.handle('accounts:subscribeMp', (_e, name: string, rsshubBase?: string) => subscribeWechatMp(name, rsshubBase))
}

/* ---- 12.2：索引状态诊断 ---- */
function registerDiagnosticsIpc(): void {
  ipcMain.handle('diag:indexStats', () => {
    const db = getDb()
    const ready = embedderReadiness()
    const pending = (db.prepare(`SELECT COUNT(*) AS n FROM contents WHERE needs_reindex = 1`).get() as { n: number }).n
    const indexed = (db.prepare(`SELECT COUNT(*) AS n FROM contents WHERE indexed_at IS NOT NULL`).get() as { n: number }).n
    const byType = db
      .prepare(`SELECT type, COUNT(*) AS n FROM contents GROUP BY type`)
      .all() as { type: string; n: number }[]
    const ftsRows = (() => {
      try {
        return (db.prepare(`SELECT COUNT(*) AS n FROM contents_fts`).get() as { n: number }).n
      } catch {
        return -1 /* FTS 不可用 */
      }
    })()
    const recentErrors = db
      .prepare(
        `SELECT json_extract(meta, '$.embedError') AS err, COUNT(*) AS n
         FROM contents WHERE json_extract(meta, '$.embedError') IS NOT NULL
         GROUP BY err ORDER BY n DESC LIMIT 10`
      )
      .all() as { err: string; n: number }[]
    return {
      pending,
      indexed,
      byType: Object.fromEntries(byType.map((r) => [r.type, r.n])),
      queueSize: embeddingQueueSize(),
      ftsRows,
      recentErrors,
      model: { textReady: ready.textReady, imageReady: ready.imageReady }
    }
  })
}

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

  /* 存量内容补打 AI 标签（在线文本模型优先，本地兜底） */
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
function registerSubsIpc(): void {
  ipcMain.handle('subs:add', async (_e, url: string) => addSubscription(url))

  ipcMain.handle('subs:list', () => {
    const db = getDb()
    return db
      .prepare(`SELECT id, kind, title, feed_url, site_url, unread, last_fetch, enabled FROM subscriptions ORDER BY created_at`)
      .all()
  })

  ipcMain.handle('subs:remove', (_e, id: number) => {
    const db = getDb()
    db.prepare(`DELETE FROM feed_items WHERE subscription_id = ?`).run(id)
    db.prepare(`DELETE FROM subscriptions WHERE id = ?`).run(id)
  })

  ipcMain.handle('subs:refresh', async (_e, id?: number) => {
    if (id) return refreshSubscription(id)
    await refreshAll()
    return null
  })

  ipcMain.handle('subs:items', (_e, opts?: { subId?: number; onlyUnread?: boolean; limit?: number }) => {
    const db = getDb()
    const limit = opts?.limit ?? 100
    const where: string[] = []
    const params: unknown[] = []
    if (opts?.subId) {
      where.push('subscription_id = ?')
      params.push(opts.subId)
    }
    if (opts?.onlyUnread) where.push('read = 0')
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    return db
      .prepare(`SELECT * FROM feed_items ${whereSql} ORDER BY published_at DESC LIMIT ?`)
      .all(...params, limit)
  })

  ipcMain.handle('subs:markRead', (_e, itemId: string, read: boolean) => {
    const db = getDb()
    db.prepare(`UPDATE feed_items SET read = ? WHERE id = ?`).run(read ? 1 : 0, itemId)
    /* R23：必须限定目标订阅——旧 SQL 缺 WHERE 把所有订阅的未读数
       都覆盖成同一值 */
    db.prepare(
      `UPDATE subscriptions SET unread = (
         SELECT COUNT(*) FROM feed_items
         WHERE subscription_id = subscriptions.id AND read = 0
       ) WHERE id = (SELECT subscription_id FROM feed_items WHERE id = ?)`
    ).run(itemId)
  })

  ipcMain.handle('subs:star', (_e, itemId: string, starred: boolean) => {
    getDb().prepare(`UPDATE feed_items SET starred = ? WHERE id = ?`).run(starred ? 1 : 0, itemId)
  })
}

/* ---- F05：批量导入导出 ---- */
function registerIoIpc(): void {
  ipcMain.handle('io:importBookmarks', async (_e, html: string) => {
    const m = await import('./io')
    return m.importBookmarks(html)
  })
  ipcMain.handle('io:importOpml', async (_e, xml: string) => {
    const m = await import('./io')
    return m.importOpml(xml)
  })
  ipcMain.handle('io:importJson', async (_e, json: string) => {
    const m = await import('./io')
    return m.importJson(json)
  })
  ipcMain.handle('io:exportJson', async () => {
    const m = await import('./io')
    return m.exportJson()
  })
  /* N09：文件读写只允许会话内经对话框选择的路径（纵深防御） */
  const sessionPaths = new Set<string>()
  ipcMain.handle('io:pickOpenFile', async (_e, extensions: string[]): Promise<string | null> => {
    const focused = win()
    const opts: Electron.OpenDialogOptions = { properties: ['openFile'], filters: [{ name: '导入文件', extensions }] }
    const res = focused ? await dialog.showOpenDialog(focused, opts) : await dialog.showOpenDialog(opts)
    const p = res.canceled ? null : (res.filePaths[0] ?? null)
    if (p) sessionPaths.add(p)
    return p
  })
  ipcMain.handle('io:pickSaveFile', async (_e, defaultName: string): Promise<string | null> => {
    const focused = win()
    const res = focused
      ? await dialog.showSaveDialog(focused, { defaultPath: defaultName })
      : await dialog.showSaveDialog({ defaultPath: defaultName })
    const p = res.canceled ? null : (res.filePath ?? null)
    if (p) sessionPaths.add(p)
    return p
  })
  ipcMain.handle('io:readFile', (_e, path: string) => {
    if (!sessionPaths.has(path)) throw new Error('路径未经用户选择，拒绝读取')
    return ioModule.readTextFile(path)
  })
  ipcMain.handle('io:writeFile', (_e, path: string, content: string) => {
    if (!sessionPaths.has(path)) throw new Error('路径未经用户选择，拒绝写入')
    return ioModule.writeTextFile(path, content)
  })
}

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
