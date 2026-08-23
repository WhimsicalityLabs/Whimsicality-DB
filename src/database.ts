import Database from 'better-sqlite3'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'

export interface SchemaVersion {
  version: number
}

const SCHEMA_VERSION = 2

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

-- Memory: namespaced key-value store
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

-- Documents: full-text searchable
CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id TEXT NOT NULL UNIQUE,
  text TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
  text, content='docs', content_rowid='id', tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
  INSERT INTO docs_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, text) VALUES('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, text) VALUES('delete', old.id, old.text);
  INSERT INTO docs_fts(rowid, text) VALUES (new.id, new.text);
END;

-- Cache: compressed paged content
CREATE TABLE IF NOT EXISTS cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_id TEXT NOT NULL UNIQUE,
  topic TEXT NOT NULL,
  summary TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  content BLOB NOT NULL,
  original_size INTEGER NOT NULL,
  compressed_size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS cache_fts USING fts5(
  topic, summary, tags, content='cache', content_rowid='id', tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS cache_ai AFTER INSERT ON cache BEGIN
  INSERT INTO cache_fts(rowid, topic, summary, tags) VALUES (new.id, new.topic, new.summary, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS cache_ad AFTER DELETE ON cache BEGIN
  INSERT INTO cache_fts(cache_fts, rowid, topic, summary, tags) VALUES('delete', old.id, old.topic, old.summary, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS cache_au AFTER UPDATE ON cache BEGIN
  INSERT INTO cache_fts(cache_fts, rowid, topic, summary, tags) VALUES('delete', old.id, old.topic, old.summary, old.tags);
  INSERT INTO cache_fts(rowid, topic, summary, tags) VALUES (new.id, new.topic, new.summary, new.tags);
END;

-- Cache tag join table (efficient tag filtering)
CREATE TABLE IF NOT EXISTS cache_tags (
  cache_id INTEGER NOT NULL,
  tag TEXT NOT NULL,
  FOREIGN KEY (cache_id) REFERENCES cache(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cache_tags_tag ON cache_tags(tag);
CREATE INDEX IF NOT EXISTS idx_cache_tags_id ON cache_tags(cache_id);

-- Todos: task tracking
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

-- Todo tag join table
CREATE TABLE IF NOT EXISTS todo_tags (
  todo_id INTEGER NOT NULL,
  tag TEXT NOT NULL,
  FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_todo_tags_tag ON todo_tags(tag);
CREATE INDEX IF NOT EXISTS idx_todo_tags_id ON todo_tags(todo_id);

-- Context index: tagged content entries for pull-by-tag retrieval
CREATE TABLE IF NOT EXISTS context_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS context_fts USING fts5(
  title, content, tags, content='context_entries', content_rowid='id', tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS context_ai AFTER INSERT ON context_entries BEGIN
  INSERT INTO context_fts(rowid, title, content, tags) VALUES (new.id, new.title, new.content, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS context_ad AFTER DELETE ON context_entries BEGIN
  INSERT INTO context_fts(context_fts, rowid, title, content, tags) VALUES('delete', old.id, old.title, old.content, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS context_au AFTER UPDATE ON context_entries BEGIN
  INSERT INTO context_fts(context_fts, rowid, title, content, tags) VALUES('delete', old.id, old.title, old.content, old.tags);
  INSERT INTO context_fts(rowid, title, content, tags) VALUES (new.id, new.title, new.content, new.tags);
END;

-- Context tag join table
CREATE TABLE IF NOT EXISTS context_tags (
  context_id INTEGER NOT NULL,
  tag TEXT NOT NULL,
  FOREIGN KEY (context_id) REFERENCES context_entries(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_context_tags_tag ON context_tags(tag);
CREATE INDEX IF NOT EXISTS idx_context_tags_id ON context_tags(context_id);

-- Sessions: long-horizon task tracking
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'abandoned')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Events: log within sessions
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

const MIGRATION_V1_TO_V2 = `
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
`

export function defaultStorageDir(): string {
  const base = join(homedir(), '.whimsicality')
  const newPath = join(base, 'db-storage')
  mkdirSync(newPath, { recursive: true })
  return newPath
}

function migrateV1ToV2(db: Database.Database): void {
  db.exec(MIGRATION_V1_TO_V2)
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
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION)
    versionRow = { version: SCHEMA_VERSION }
  }
  if (versionRow.version < 2) {
    migrateV1ToV2(db)
    db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION)
  }
  return db
}

export function closeDatabase(db: Database.Database): void {
  try { db.pragma('wal_checkpoint(TRUNCATE)') } catch { }
  db.close()
}
