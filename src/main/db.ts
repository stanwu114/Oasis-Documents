import Database from 'better-sqlite3'
import { getDbPath } from './dataLocation'
import { toBigrams } from './fts'

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(getDbPath())
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    migrate()
  }
  return db
}

export function closeDb(): void {
  db?.close()
  db = null
}

function migrate(): void {
  const d = getDb()

  /* ---- 内容主表 ----
     type 列存六分类（image/video/drawing/audio/document/other）+ webpage/note
     R04：hash 不再全局唯一——相同内容的两个物理文件都必须可见，
          哈希仅用于重复分组与提取缓存 */
  d.exec(`
    CREATE TABLE IF NOT EXISTS contents (
      id            TEXT PRIMARY KEY,
      type          TEXT NOT NULL,
      title         TEXT NOT NULL DEFAULT '',
      content       TEXT DEFAULT '',
      source_path   TEXT,
      url           TEXT,
      platform      TEXT,
      mime_type     TEXT,
      file_size     INTEGER,
      hash          TEXT,
      thumbnail_path TEXT,
      ocr_text      TEXT DEFAULT '',
      tags          TEXT DEFAULT '[]',
      meta          TEXT DEFAULT '{}',
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      indexed_at    INTEGER,
      needs_reindex INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_contents_type ON contents(type);
    CREATE INDEX IF NOT EXISTS idx_contents_hash ON contents(hash);
    CREATE INDEX IF NOT EXISTS idx_contents_path ON contents(source_path);
    CREATE INDEX IF NOT EXISTS idx_contents_needs_reindex ON contents(needs_reindex);
    CREATE INDEX IF NOT EXISTS idx_contents_created ON contents(created_at);
  `)

  /* 旧表迁移：R04 去掉 hash 的 UNIQUE 约束；R02 时代去掉 type CHECK 的迁移一并兼容 */
  const oldTable = d
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='contents'`)
    .get() as { sql: string } | undefined
  if (oldTable?.sql?.includes('UNIQUE') || oldTable?.sql?.includes('CHECK(type IN')) {
    d.exec(`
      ALTER TABLE contents RENAME TO contents_old;
      CREATE TABLE contents (
        id            TEXT PRIMARY KEY,
        type          TEXT NOT NULL,
        title         TEXT NOT NULL DEFAULT '',
        content       TEXT DEFAULT '',
        source_path   TEXT,
        url           TEXT,
        platform      TEXT,
        mime_type     TEXT,
        file_size     INTEGER,
        hash          TEXT,
        thumbnail_path TEXT,
        ocr_text      TEXT DEFAULT '',
        tags          TEXT DEFAULT '[]',
        meta          TEXT DEFAULT '{}',
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        indexed_at    INTEGER,
        needs_reindex INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO contents SELECT * FROM contents_old;
      DROP TABLE contents_old;
      CREATE INDEX IF NOT EXISTS idx_contents_type ON contents(type);
      CREATE INDEX IF NOT EXISTS idx_contents_hash ON contents(hash);
      CREATE INDEX IF NOT EXISTS idx_contents_path ON contents(source_path);
      CREATE INDEX IF NOT EXISTS idx_contents_needs_reindex ON contents(needs_reindex);
      CREATE INDEX IF NOT EXISTS idx_contents_created ON contents(created_at);
    `)
  }

  /* ---- 文件监控路径表 ---- */
  d.exec(`
    CREATE TABLE IF NOT EXISTS watch_paths (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      path       TEXT NOT NULL UNIQUE,
      enabled    INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
  `)

  /* ---- 设置表 ---- */
  d.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  /* ---- 平台账号/授权表 ---- */
  d.exec(`
    CREATE TABLE IF NOT EXISTS platform_accounts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      platform    TEXT NOT NULL,
      auth_data   TEXT DEFAULT '{}',
      last_sync   INTEGER,
      created_at  INTEGER NOT NULL
    );
  `)

  /* ---- 同步日志表 ---- */
  d.exec(`
    CREATE TABLE IF NOT EXISTS sync_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      platform    TEXT NOT NULL,
      status      TEXT NOT NULL CHECK(status IN ('success','error','partial')),
      message     TEXT,
      items_count INTEGER DEFAULT 0,
      created_at  INTEGER NOT NULL
    );
  `)

  /* ---- 全文检索（阶段 D）：FTS5 + 中文 bigram 预分词 ---- */
  const ftsOk = (() => {
    try {
      d.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS contents_fts USING fts5(
          content_id UNINDEXED, title, body, tokenize='unicode61'
        )
      `)
      return true
    } catch (e) {
      console.warn('[db] FTS5 不可用，关键词检索回退 LIKE:', e instanceof Error ? e.message : e)
      return false
    }
  })()

  /* 对账：contents 与 fts 行数不一致时全量重建（启动一次性，量级数百毫秒） */
  if (ftsOk) {
    const total = (d.prepare(`SELECT COUNT(*) AS n FROM contents`).get() as { n: number }).n
    const ftsN = (d.prepare(`SELECT COUNT(*) AS n FROM contents_fts`).get() as { n: number }).n
    if (total !== ftsN) {
      d.exec(`DELETE FROM contents_fts`)
      const rows = d
        .prepare(`SELECT id, title, COALESCE(content,'') AS c, COALESCE(ocr_text,'') AS o FROM contents`)
        .all() as { id: string; title: string; c: string; o: string }[]
      const ins = d.prepare(`INSERT INTO contents_fts (content_id, title, body) VALUES (?, ?, ?)`)
      const bigram = (s: string): string => toBigrams(s)
      const run = d.transaction(() => {
        for (const r of rows) ins.run(r.id, bigram(r.title), bigram(`${r.c} ${r.o}`))
      })
      run()
      console.log(`[db] FTS 对账重建 ${rows.length} 条`)
    }
  }

  /* ---- 文件哈希表（整理：精确+感知去重） ---- */
  d.exec(`
    CREATE TABLE IF NOT EXISTS file_hashes (
      path       TEXT PRIMARY KEY,
      sha256     TEXT,
      phash      TEXT,
      size       INTEGER,
      scanned_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_file_hashes_sha ON file_hashes(sha256);
    CREATE INDEX IF NOT EXISTS idx_file_hashes_phash ON file_hashes(phash);
  `)

  /* ---- 重复组表（整理建议的载体） ---- */
  d.exec(`
    CREATE TABLE IF NOT EXISTS duplicate_groups (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      kind         TEXT NOT NULL CHECK(kind IN ('exact','near-image')),
      hash_key     TEXT NOT NULL,
      file_paths   TEXT NOT NULL DEFAULT '[]',
      wasted_bytes INTEGER NOT NULL DEFAULT 0,
      keep_path    TEXT,
      status       TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved','dismissed')),
      created_at   INTEGER NOT NULL,
      resolved_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_dup_groups_status ON duplicate_groups(status);
  `)

  /* ---- 整理规则表（声明式规则，UI 可编辑） ---- */
  d.exec(`
    CREATE TABLE IF NOT EXISTS organize_rules (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      priority    INTEGER NOT NULL DEFAULT 0,
      rule_yaml   TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
  `)

  /* ---- 整理建议表（规则引擎产出，待用户确认） ---- */
  d.exec(`
    CREATE TABLE IF NOT EXISTS organize_suggestions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id     INTEGER REFERENCES organize_rules(id),
      file_path   TEXT NOT NULL,
      action      TEXT NOT NULL CHECK(action IN ('move','trash','tag')),
      target_path TEXT,
      reason      TEXT,
      status      TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','done','failed')),
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_suggestions_status ON organize_suggestions(status);
  `)

  /* ---- 整理操作日志（撤销与审计的依据） ---- */
  d.exec(`
    CREATE TABLE IF NOT EXISTS organize_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id    TEXT NOT NULL,
      action      TEXT NOT NULL CHECK(action IN ('move','trash','tag')),
      from_path   TEXT NOT NULL,
      to_path     TEXT,
      status      TEXT NOT NULL CHECK(status IN ('done','failed','reverted')),
      error       TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_organize_logs_batch ON organize_logs(batch_id);
  `)

  /* ---- F03：用户笔记与划线（关联资产，正文更新后按锚文本尽量保持） ---- */
  d.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      content_id  TEXT NOT NULL,
      anchor_text TEXT NOT NULL,
      note        TEXT DEFAULT '',
      color      TEXT DEFAULT 'accent',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notes_content ON notes(content_id);
  `)

  /* ---- 订阅源表（目标④） ---- */
  d.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      kind        TEXT NOT NULL CHECK(kind IN ('rss','wechat-rss','csdn','bilibili','newsletter')),
      title       TEXT NOT NULL,
      feed_url    TEXT NOT NULL,
      site_url    TEXT,
      favicon_path TEXT,
      unread      INTEGER NOT NULL DEFAULT 0,
      last_fetch  INTEGER,
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  INTEGER NOT NULL
    );
  `)

  /* ---- 订阅条目表（时间线） ---- */
  d.exec(`
    CREATE TABLE IF NOT EXISTS feed_items (
      id           TEXT PRIMARY KEY,
      subscription_id INTEGER NOT NULL REFERENCES subscriptions(id),
      title        TEXT NOT NULL,
      url          TEXT NOT NULL,
      author       TEXT,
      summary      TEXT DEFAULT '',
      content_path TEXT,
      published_at INTEGER NOT NULL,
      read         INTEGER NOT NULL DEFAULT 0,
      starred      INTEGER NOT NULL DEFAULT 0,
      fetched_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feed_items_sub ON feed_items(subscription_id, published_at);
    CREATE INDEX IF NOT EXISTS idx_feed_items_unread ON feed_items(read);
  `)
}
