import Database from 'better-sqlite3'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'

export interface SchemaVersion {
  version: number
}

const SCHEMA_VERSION = 3

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL DEFAULT 'default',
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(namespace, key)
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  value, content='memory', content_rowid='id', tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
  INSERT INTO memory_fts(rowid, value) VALUES (new.id, new.value);
END;
CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, value) VALUES('delete', old.id, old.value);
END;
CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, value) VALUES('delete', old.id, old.value);
  INSERT INTO memory_fts(rowid, value) VALUES (new.id, new.value);
END;

CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  content BLOB,
  content_text TEXT,
  is_compressed INTEGER NOT NULL DEFAULT 0,
  original_size INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  title, content_text, content='entries', content_rowid='id', tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, title, content_text) VALUES (new.id, new.title, new.content_text);
END;
CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, content_text) VALUES('delete', old.id, old.title, old.content_text);
END;
CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, content_text) VALUES('delete', old.id, old.title, old.content_text);
  INSERT INTO entries_fts(rowid, title, content_text) VALUES (new.id, new.title, new.content_text);
END;

CREATE TABLE IF NOT EXISTS entry_tags (
  entry_id INTEGER NOT NULL,
  tag TEXT NOT NULL,
  FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_entry_tags_tag ON entry_tags(tag);
CREATE INDEX IF NOT EXISTS idx_entry_tags_id ON entry_tags(entry_id);

CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed')),
  priority INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]',
  session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS todos_fts USING fts5(
  title, description, tags, content='todos', content_rowid='id', tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS todos_ai AFTER INSERT ON todos BEGIN
  INSERT INTO todos_fts(rowid, title, description, tags) VALUES (new.id, new.title, new.description, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS todos_ad AFTER DELETE ON todos BEGIN
  INSERT INTO todos_fts(todos_fts, rowid, title, description, tags) VALUES('delete', old.id, old.title, old.description, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS todos_au AFTER UPDATE ON todos BEGIN
  INSERT INTO todos_fts(todos_fts, rowid, title, description, tags) VALUES('delete', old.id, old.title, old.description, old.tags);
  INSERT INTO todos_fts(rowid, title, description, tags) VALUES (new.id, new.title, new.description, new.tags);
END;

CREATE TABLE IF NOT EXISTS todo_tags (
  todo_id INTEGER NOT NULL,
  tag TEXT NOT NULL,
  FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_todo_tags_tag ON todo_tags(tag);
CREATE INDEX IF NOT EXISTS idx_todo_tags_id ON todo_tags(todo_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'abandoned')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  event_type TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  content, content='events', content_rowid='id', tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, content) VALUES('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO events_fts(rowid, content) VALUES (new.id, new.content);
END;
`

export function defaultStorageDir(): string {
  const base = join(homedir(), '.whimsicality')
  const newPath = join(base, 'db-storage')
  mkdirSync(newPath, { recursive: true })
  return newPath
}

function migrateV1ToV2(db: Database.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS cache_tags (
  cache_id INTEGER NOT NULL,
  tag TEXT NOT NULL,
  FOREIGN KEY (cache_id) REFERENCES cache(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cache_tags_tag ON cache_tags(tag);
CREATE INDEX IF NOT EXISTS idx_cache_tags_id ON cache_tags(cache_id);

CREATE TABLE IF NOT EXISTS todo_tags (
  todo_id INTEGER NOT NULL,
  tag TEXT NOT NULL,
  FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_todo_tags_tag ON todo_tags(tag);
CREATE INDEX IF NOT EXISTS idx_todo_tags_id ON todo_tags(todo_id);

CREATE TABLE IF NOT EXISTS context_tags (
  context_id INTEGER NOT NULL,
  tag TEXT NOT NULL,
  FOREIGN KEY (context_id) REFERENCES context_entries(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_context_tags_tag ON context_tags(tag);
CREATE INDEX IF NOT EXISTS idx_context_tags_id ON context_tags(context_id);
`)
  const migrateTags = (table: string, idCol: string, tagTable: string, tagIdCol: string): void => {
    const rows = db.prepare(`SELECT ${idCol} AS id, tags FROM ${table}`).all() as { id: number; tags: string }[]
    const insert = db.prepare(`INSERT OR IGNORE INTO ${tagTable} (${tagIdCol}, tag) VALUES (?, ?)`)
    for (const row of rows) {
      let tags: string[] = []
      try { tags = JSON.parse(row.tags) as string[] } catch { continue }
      for (const tag of tags) {
        if (typeof tag === 'string' && tag.length > 0) insert.run(row.id, tag)
      }
    }
  }
  migrateTags('cache', 'id', 'cache_tags', 'cache_id')
  migrateTags('todos', 'id', 'todo_tags', 'todo_id')
  migrateTags('context_entries', 'id', 'context_tags', 'context_id')
}

function migrateV2ToV3(db: Database.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  content BLOB,
  content_text TEXT,
  is_compressed INTEGER NOT NULL DEFAULT 0,
  original_size INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  title, content_text, content='entries', content_rowid='id', tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, title, content_text) VALUES (new.id, new.title, new.content_text);
END;
CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, content_text) VALUES('delete', old.id, old.title, old.content_text);
END;
CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, content_text) VALUES('delete', old.id, old.title, old.content_text);
  INSERT INTO entries_fts(rowid, title, content_text) VALUES (new.id, new.title, new.content_text);
END;

CREATE TABLE IF NOT EXISTS entry_tags (
  entry_id INTEGER NOT NULL,
  tag TEXT NOT NULL,
  FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_entry_tags_tag ON entry_tags(tag);
CREATE INDEX IF NOT EXISTS idx_entry_tags_id ON entry_tags(entry_id);
`)

  const insertEntry = db.prepare(`
    INSERT OR IGNORE INTO entries (entry_id, title, content, content_text, is_compressed, original_size, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertTag = db.prepare('INSERT OR IGNORE INTO entry_tags (entry_id, tag) VALUES (?, ?)')

  const docs = db.prepare('SELECT doc_id, text, language, description, created_at, updated_at FROM docs').all() as { doc_id: string; text: string; language: string; description: string; created_at: string; updated_at: string }[]
  for (const d of docs) {
    insertEntry.run(d.doc_id, d.description, null, d.text, 0, d.text.length, d.language, d.created_at, d.updated_at)
  }

  const cache = db.prepare('SELECT chunk_id, topic, summary, content, original_size, created_at, updated_at FROM cache').all() as { chunk_id: string; topic: string; summary: string; content: Buffer; original_size: number; created_at: string; updated_at: string }[]
  for (const c of cache) {
    insertEntry.run(c.chunk_id, c.summary, c.content, c.topic, 1, c.original_size, '', c.created_at, c.updated_at)
  }

  const contexts = db.prepare('SELECT entry_id, title, content, source, created_at, updated_at FROM context_entries').all() as { entry_id: string; title: string; content: string; source: string; created_at: string; updated_at: string }[]
  for (const c of contexts) {
    insertEntry.run(c.entry_id, c.title, null, c.content, 0, c.content.length, c.source, c.created_at, c.updated_at)
  }

  const cacheTags = db.prepare('SELECT ct.tag, e.id FROM cache_tags ct JOIN cache c ON c.id = ct.cache_id JOIN entries e ON e.entry_id = c.chunk_id').all() as { tag: string; id: number }[]
  for (const t of cacheTags) insertTag.run(t.id, t.tag)

  const contextTags = db.prepare('SELECT ct.tag, e.id FROM context_tags ct JOIN context_entries ce ON ce.id = ct.context_id JOIN entries e ON e.entry_id = ce.entry_id').all() as { tag: string; id: number }[]
  for (const t of contextTags) insertTag.run(t.id, t.tag)

  db.exec(`
DROP TRIGGER IF EXISTS docs_ai; DROP TRIGGER IF EXISTS docs_ad; DROP TRIGGER IF EXISTS docs_au;
DROP TRIGGER IF EXISTS cache_ai; DROP TRIGGER IF EXISTS cache_ad; DROP TRIGGER IF EXISTS cache_au;
DROP TRIGGER IF EXISTS context_ai; DROP TRIGGER IF EXISTS context_ad; DROP TRIGGER IF EXISTS context_au;
DROP TABLE IF EXISTS docs_fts; DROP TABLE IF EXISTS cache_fts; DROP TABLE IF EXISTS context_fts;
DROP TABLE IF EXISTS cache_tags; DROP TABLE IF EXISTS context_tags;
DROP TABLE IF EXISTS docs; DROP TABLE IF EXISTS cache; DROP TABLE IF EXISTS context_entries;
`)
}

export function openDatabase(storageDir: string): Database.Database {
  const dbPath = join(storageDir, 'whimsicality.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.exec(SCHEMA_SQL)
  let versionRow = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as SchemaVersion | undefined
  if (!versionRow) {
    const hasOldTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('docs','cache','context_entries')").get() as { name: string } | undefined
    const initialVersion = hasOldTables ? 2 : SCHEMA_VERSION
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(initialVersion)
    versionRow = { version: initialVersion }
  }
  if (versionRow.version < 2) {
    migrateV1ToV2(db)
    versionRow = { version: 2 }
  }
  if (versionRow.version < 3) {
    migrateV2ToV3(db)
    versionRow = { version: 3 }
  }
  db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION)
  return db
}

export function closeDatabase(db: Database.Database): void {
  try { db.pragma('wal_checkpoint(TRUNCATE)') } catch { }
  db.close()
}
