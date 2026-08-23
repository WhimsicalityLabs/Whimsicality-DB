import type Database from 'better-sqlite3'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

const now = (): string => new Date().toISOString()

export interface MemoryEntry { key: string; namespace: string; value: string; created_at: string; updated_at: string }
export interface DocEntry { doc_id: string; text: string; language: string; description: string; created_at: string; updated_at: string }
export interface CacheEntry { chunk_id: string; topic: string; summary: string; tags: string[]; original_size: number; compressed_size: number; created_at: string; updated_at: string }
export interface TodoEntry { id: number; title: string; description: string; status: string; priority: number; tags: string[]; session_id: string | null; created_at: string; updated_at: string }
export interface ContextEntry { entry_id: string; title: string; content: string; tags: string[]; source: string; created_at: string; updated_at: string }
export interface SessionEntry { id: string; name: string; description: string; status: string; created_at: string; updated_at: string }
export interface EventEntry { id: number; session_id: string | null; event_type: string; content: string; metadata: string; created_at: string }

export interface SearchResult { id: string | number; score: number; [key: string]: unknown }

const MAX_CONTENT_CHARS = 5_000_000
const MAX_TEXT_CHARS = 1_000_000
const MAX_IDENTIFIER_CHARS = 256
const MAX_TAGS = 20
const MAX_TAG_CHARS = 256
const DEFAULT_READ_LENGTH = 8_000
const DEFAULT_LIMIT = 100

const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed'])
const SESSION_STATUSES = new Set(['active', 'paused', 'completed', 'abandoned'])

function validateId(id: string, name: string): string {
  if (!id || id.length === 0) throw new Error(`Argument "${name}" must be a non-empty string`)
  if (id.length > MAX_IDENTIFIER_CHARS) throw new Error(`Argument "${name}" exceeds maximum length of ${MAX_IDENTIFIER_CHARS}`)
  return id
}

function validateText(text: string, name: string, max = MAX_TEXT_CHARS): string {
  if (typeof text !== 'string' || text.length === 0) throw new Error(`Missing or invalid required argument: "${name}" (expected non-empty string)`)
  if (text.length > max) throw new Error(`Argument "${name}" exceeds maximum length of ${max}`)
  return text
}

function validateTags(tags: unknown): string[] {
  const result: string[] = []
  if (tags === undefined || tags === null) return result
  if (!Array.isArray(tags)) throw new Error('tags must be an array of strings')
  for (const t of tags) {
    if (typeof t !== 'string' || t.length === 0) throw new Error('tags must be non-empty strings')
    if (t.length > MAX_TAG_CHARS) throw new Error(`tag exceeds maximum length of ${MAX_TAG_CHARS}`)
    result.push(t)
  }
  if (result.length > MAX_TAGS) throw new Error(`too many tags (max ${MAX_TAGS})`)
  return result
}

function validateTodoStatus(status: string): string {
  if (!TODO_STATUSES.has(status)) throw new Error(`Invalid todo status "${status}". Must be one of: ${[...TODO_STATUSES].join(', ')}`)
  return status
}

function validateSessionStatus(status: string): string {
  if (!SESSION_STATUSES.has(status)) throw new Error(`Invalid session status "${status}". Must be one of: ${[...SESSION_STATUSES].join(', ')}`)
  return status
}

function parseTags(json: string): string[] {
  try { return JSON.parse(json) as string[] } catch { return [] }
}

function toFtsQuery(raw: string): string {
  const terms = raw.match(/[\p{L}\p{N}_]+/gu) ?? []
  if (terms.length === 0) throw new Error('query has no searchable terms')
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')
}

export class Store {
  private readonly db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  private syncTags(tagTable: string, idCol: string, parentId: number, tags: string[]): void {
    this.db.prepare(`DELETE FROM ${tagTable} WHERE ${idCol} = ?`).run(parentId)
    const insert = this.db.prepare(`INSERT INTO ${tagTable} (${idCol}, tag) VALUES (?, ?)`)
    for (const tag of tags) insert.run(parentId, tag)
  }

  // ─── Memory ───

  memorySet(namespace: string, key: string, value: string): { stored: boolean } {
    validateId(key, 'key')
    validateText(value, 'value')
    const ts = now()
    this.db.prepare(`
      INSERT INTO memory (namespace, key, value, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(namespace, key, value, ts, ts)
    return { stored: true }
  }

  memoryGet(namespace: string, key: string): MemoryEntry {
    validateId(key, 'key')
    const row = this.db.prepare('SELECT key, namespace, value, created_at, updated_at FROM memory WHERE namespace = ? AND key = ?').get(namespace, key) as MemoryEntry | undefined
    if (!row) throw new Error(`not found: ${namespace}/${key}`)
    return row
  }

  memoryList(namespace: string): { keys: string[] } {
    const rows = this.db.prepare('SELECT key FROM memory WHERE namespace = ? ORDER BY key').all(namespace) as { key: string }[]
    return { keys: rows.map((r) => r.key) }
  }

  memoryDelete(namespace: string, key: string): { deleted: boolean } {
    validateId(key, 'key')
    const result = this.db.prepare('DELETE FROM memory WHERE namespace = ? AND key = ?').run(namespace, key)
    return { deleted: result.changes > 0 }
  }

  memorySearch(query: string, topK: number, raw: boolean): SearchResult[] {
    validateText(query, 'query', 10_000)
    const ftsQuery = raw ? query : toFtsQuery(query)
    const rows = this.db.prepare(`
      SELECT m.key AS id, m.namespace, m.value, -bm25(memory_fts) AS score
      FROM memory_fts JOIN memory m ON m.id = memory_fts.rowid
      WHERE memory_fts MATCH ?
      ORDER BY score DESC
      LIMIT ?
    `).all(ftsQuery, topK) as SearchResult[]
    return rows
  }

  // ─── Docs ───

  docSave(docId: string, text: string, language: string, description: string): { saved: boolean } {
    validateId(docId, 'id')
    validateText(text, 'text')
    const ts = now()
    this.db.prepare(`
      INSERT INTO docs (doc_id, text, language, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(doc_id) DO UPDATE SET text = excluded.text, language = excluded.language, description = excluded.description, updated_at = excluded.updated_at
    `).run(docId, text, language, description, ts, ts)
    return { saved: true }
  }

  docGet(docId: string): DocEntry {
    validateId(docId, 'id')
    const row = this.db.prepare('SELECT doc_id, text, language, description, created_at, updated_at FROM docs WHERE doc_id = ?').get(docId) as DocEntry | undefined
    if (!row) throw new Error(`not found: ${docId}`)
    return row
  }

  docList(): { ids: string[] } {
    const rows = this.db.prepare('SELECT doc_id FROM docs ORDER BY doc_id').all() as { doc_id: string }[]
    return { ids: rows.map((r) => r.doc_id) }
  }

  docDelete(docId: string): { deleted: boolean } {
    validateId(docId, 'id')
    const result = this.db.prepare('DELETE FROM docs WHERE doc_id = ?').run(docId)
    return { deleted: result.changes > 0 }
  }

  docSearch(query: string, topK: number, raw: boolean): SearchResult[] {
    validateText(query, 'query', 10_000)
    const ftsQuery = raw ? query : toFtsQuery(query)
    const rows = this.db.prepare(`
      SELECT d.doc_id AS id, d.language, d.description,
             snippet(docs_fts, 0, '<<', '>>', '…', 48) AS excerpt,
             -bm25(docs_fts) AS score
      FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid
      WHERE docs_fts MATCH ?
      ORDER BY score DESC
      LIMIT ?
    `).all(ftsQuery, topK) as SearchResult[]
    return rows
  }

  // ─── Cache (compressed paged content) ───

  cacheStore(chunkId: string, content: string, topic: string, summary: string, tags: string[]): { id: string; original_size: number; compressed_size: number; ratio: number } {
    validateId(chunkId, 'id')
    validateText(content, 'content', MAX_CONTENT_CHARS)
    const compressed = brotliCompressSync(Buffer.from(content, 'utf-8'))
    const originalSize = Buffer.byteLength(content, 'utf-8')
    const compressedSize = compressed.length
    const tagsJson = JSON.stringify(tags)
    const ts = now()
    const tx = this.db.transaction(() => {
      const result = this.db.prepare(`
        INSERT INTO cache (chunk_id, topic, summary, tags, content, original_size, compressed_size, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chunk_id) DO UPDATE SET topic = excluded.topic, summary = excluded.summary, tags = excluded.tags, content = excluded.content, original_size = excluded.original_size, compressed_size = excluded.compressed_size, updated_at = excluded.updated_at
      `).run(chunkId, topic, summary, tagsJson, compressed, originalSize, compressedSize, ts, ts)
      const cacheId = Number(result.lastInsertRowid)
      this.syncTags('cache_tags', 'cache_id', cacheId, tags)
    })
    tx()
    return { id: chunkId, original_size: originalSize, compressed_size: compressedSize, ratio: originalSize > 0 ? compressedSize / originalSize : 0 }
  }

  cacheRead(chunkId: string, offset: number, length: number): { content: string; topic: string; summary: string; tags: string[]; offset: number; length: number; total_length: number; has_more: boolean } {
    validateId(chunkId, 'id')
    const row = this.db.prepare('SELECT content, topic, summary, tags, original_size FROM cache WHERE chunk_id = ?').get(chunkId) as { content: Buffer; topic: string; summary: string; tags: string; original_size: number } | undefined
    if (!row) throw new Error(`not found: ${chunkId}`)
    const fullContent = brotliDecompressSync(row.content).toString('utf-8')
    const totalLength = fullContent.length
    const start = Math.max(0, Math.min(offset, totalLength))
    const end = Math.min(start + length, totalLength)
    return {
      content: fullContent.slice(start, end),
      topic: row.topic,
      summary: row.summary,
      tags: parseTags(row.tags),
      offset: start,
      length: end - start,
      total_length: totalLength,
      has_more: end < totalLength,
    }
  }

  cacheIndex(topicFilter: string | null, tagFilter: string | null, limit: number): string {
    let rows: { chunk_id: string; topic: string; summary: string }[]
    if (tagFilter) {
      rows = this.db.prepare(`
        SELECT c.chunk_id, c.topic, c.summary FROM cache c
        JOIN cache_tags ct ON ct.cache_id = c.id
        WHERE ct.tag = ?
        ORDER BY c.updated_at DESC LIMIT ?
      `).all(tagFilter, limit) as { chunk_id: string; topic: string; summary: string }[]
    } else if (topicFilter) {
      const filter = `%${topicFilter}%`
      rows = this.db.prepare(`
        SELECT chunk_id, topic, summary FROM cache
        WHERE topic LIKE ? OR summary LIKE ?
        ORDER BY updated_at DESC LIMIT ?
      `).all(filter, filter, limit) as { chunk_id: string; topic: string; summary: string }[]
    } else {
      rows = this.db.prepare('SELECT chunk_id, topic, summary FROM cache ORDER BY updated_at DESC LIMIT ?').all(limit) as { chunk_id: string; topic: string; summary: string }[]
    }
    if (rows.length === 0) return '## Context Cache (0 entries)\n(empty)'
    const lines = rows.map((r) => `| ${r.chunk_id} | ${r.topic} | ${r.summary} |`)
    const table = `## Context Cache (${rows.length} entries)\n| ID | Topic | Summary |\n|----|-------|---------|\n${lines.join('\n')}`
    const tokens = Math.ceil(table.length / 4)
    return `${table}\n\n~${tokens} tokens. Use db_cache_read with an ID to retrieve content (supports offset+length for paging).`
  }

  cacheSearch(query: string, topK: number, raw: boolean): SearchResult[] {
    validateText(query, 'query', 10_000)
    const ftsQuery = raw ? query : toFtsQuery(query)
    const rows = this.db.prepare(`
      SELECT c.chunk_id AS id, c.topic, c.summary, -bm25(cache_fts) AS score
      FROM cache_fts JOIN cache c ON c.id = cache_fts.rowid
      WHERE cache_fts MATCH ?
      ORDER BY score DESC LIMIT ?
    `).all(ftsQuery, topK) as SearchResult[]
    return rows
  }

  cacheList(): { ids: string[] } {
    const rows = this.db.prepare('SELECT chunk_id FROM cache ORDER BY chunk_id').all() as { chunk_id: string }[]
    return { ids: rows.map((r) => r.chunk_id) }
  }

  cacheDelete(chunkId: string): { deleted: boolean } {
    validateId(chunkId, 'id')
    const result = this.db.prepare('DELETE FROM cache WHERE chunk_id = ?').run(chunkId)
    return { deleted: result.changes > 0 }
  }

  cacheStats(): { entries: number; total_original_bytes: number; total_compressed_bytes: number; ratio: number } {
    const row = this.db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(original_size), 0) AS orig, COALESCE(SUM(compressed_size), 0) AS comp FROM cache').get() as { count: number; orig: number; comp: number }
    return { entries: row.count, total_original_bytes: row.orig, total_compressed_bytes: row.comp, ratio: row.orig > 0 ? row.comp / row.orig : 0 }
  }

  // ─── Todos ───

  todoAdd(title: string, description: string, priority: number, tags: string[], sessionId: string | null): { id: number } {
    validateText(title, 'title', 10_000)
    const ts = now()
    const tagsJson = JSON.stringify(tags)
    const tx = this.db.transaction(() => {
      const result = this.db.prepare(`
        INSERT INTO todos (title, description, status, priority, tags, session_id, created_at, updated_at)
        VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)
      `).run(title, description, priority, tagsJson, sessionId, ts, ts)
      const todoId = Number(result.lastInsertRowid)
      this.syncTags('todo_tags', 'todo_id', todoId, tags)
      return todoId
    })
    return { id: tx() }
  }

  todoList(status: string | null, tag: string | null, sessionId: string | null, limit: number): TodoEntry[] {
    let sql = 'SELECT DISTINCT t.id, t.title, t.description, t.status, t.priority, t.tags, t.session_id, t.created_at, t.updated_at FROM todos t'
    const conditions: string[] = []
    const params: unknown[] = []
    if (tag) { sql += ' JOIN todo_tags tt ON tt.todo_id = t.id'; conditions.push('tt.tag = ?'); params.push(tag) }
    if (status) { conditions.push('t.status = ?'); params.push(status) }
    if (sessionId) { conditions.push('t.session_id = ?'); params.push(sessionId) }
    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ')
    sql += ' ORDER BY t.priority DESC, t.created_at ASC LIMIT ?'
    params.push(limit)
    const rows = this.db.prepare(sql).all(...params) as (Omit<TodoEntry, 'tags'> & { tags: string })[]
    return rows.map((r) => ({ ...r, tags: parseTags(r.tags) }))
  }

  todoUpdate(id: number, status: string | null, title: string | null, description: string | null, priority: number | null): { updated: boolean } {
    const existing = this.db.prepare('SELECT id FROM todos WHERE id = ?').get(id)
    if (!existing) throw new Error(`not found: todo ${id}`)
    if (status !== null) validateTodoStatus(status)
    const sets: string[] = ['updated_at = ?']
    const params: unknown[] = [now()]
    if (status !== null) { sets.push('status = ?'); params.push(status) }
    if (title !== null) { sets.push('title = ?'); params.push(title) }
    if (description !== null) { sets.push('description = ?'); params.push(description) }
    if (priority !== null) { sets.push('priority = ?'); params.push(priority) }
    params.push(id)
    this.db.prepare(`UPDATE todos SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    return { updated: true }
  }

  todoDelete(id: number): { deleted: boolean } {
    const result = this.db.prepare('DELETE FROM todos WHERE id = ?').run(id)
    return { deleted: result.changes > 0 }
  }

  todoSearch(query: string, topK: number, raw: boolean): SearchResult[] {
    validateText(query, 'query', 10_000)
    const ftsQuery = raw ? query : toFtsQuery(query)
    const rows = this.db.prepare(`
      SELECT t.id, t.title, t.status, t.priority, -bm25(todos_fts) AS score
      FROM todos_fts JOIN todos t ON t.id = todos_fts.rowid
      WHERE todos_fts MATCH ?
      ORDER BY score DESC LIMIT ?
    `).all(ftsQuery, topK) as SearchResult[]
    return rows
  }

  // ─── Context Index (tagged entries) ───

  contextAdd(entryId: string, title: string, content: string, tags: string[], source: string): { id: string } {
    validateId(entryId, 'entry_id')
    validateText(title, 'title', 10_000)
    validateText(content, 'content', MAX_CONTENT_CHARS)
    const ts = now()
    const tagsJson = JSON.stringify(tags)
    const tx = this.db.transaction(() => {
      const result = this.db.prepare(`
        INSERT INTO context_entries (entry_id, title, content, tags, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entry_id) DO UPDATE SET title = excluded.title, content = excluded.content, tags = excluded.tags, source = excluded.source, updated_at = excluded.updated_at
      `).run(entryId, title, content, tagsJson, source, ts, ts)
      const contextId = Number(result.lastInsertRowid)
      this.syncTags('context_tags', 'context_id', contextId, tags)
    })
    tx()
    return { id: entryId }
  }

  contextGet(entryId: string): ContextEntry {
    validateId(entryId, 'entry_id')
    const row = this.db.prepare('SELECT entry_id, title, content, tags, source, created_at, updated_at FROM context_entries WHERE entry_id = ?').get(entryId) as (Omit<ContextEntry, 'tags'> & { tags: string }) | undefined
    if (!row) throw new Error(`not found: ${entryId}`)
    return { ...row, tags: parseTags(row.tags) }
  }

  contextByTags(tags: string[], limit: number): ContextEntry[] {
    if (tags.length === 0) throw new Error('at least one tag required')
    const placeholders = tags.map(() => '?').join(', ')
    const rows = this.db.prepare(`
      SELECT DISTINCT ce.entry_id, ce.title, ce.content, ce.tags, ce.source, ce.created_at, ce.updated_at
      FROM context_entries ce
      JOIN context_tags ct ON ct.context_id = ce.id
      WHERE ct.tag IN (${placeholders})
      ORDER BY ce.updated_at DESC LIMIT ?
    `).all(...tags, limit) as (Omit<ContextEntry, 'tags'> & { tags: string })[]
    return rows.map((r) => ({ ...r, tags: parseTags(r.tags) }))
  }

  contextSearch(query: string, topK: number, raw: boolean): SearchResult[] {
    validateText(query, 'query', 10_000)
    const ftsQuery = raw ? query : toFtsQuery(query)
    const rows = this.db.prepare(`
      SELECT c.entry_id AS id, c.title, c.tags, -bm25(context_fts) AS score
      FROM context_fts JOIN context_entries c ON c.id = context_fts.rowid
      WHERE context_fts MATCH ?
      ORDER BY score DESC LIMIT ?
    `).all(ftsQuery, topK) as SearchResult[]
    return rows
  }

  contextDelete(entryId: string): { deleted: boolean } {
    validateId(entryId, 'entry_id')
    const result = this.db.prepare('DELETE FROM context_entries WHERE entry_id = ?').run(entryId)
    return { deleted: result.changes > 0 }
  }

  // ─── Sessions ───

  sessionCreate(id: string, name: string, description: string): { id: string } {
    validateId(id, 'id')
    validateText(name, 'name', 10_000)
    const ts = now()
    this.db.prepare(`
      INSERT INTO sessions (id, name, description, status, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, updated_at = excluded.updated_at
    `).run(id, name, description, ts, ts)
    return { id }
  }

  sessionGet(id: string): SessionEntry {
    validateId(id, 'id')
    const row = this.db.prepare('SELECT id, name, description, status, created_at, updated_at FROM sessions WHERE id = ?').get(id) as SessionEntry | undefined
    if (!row) throw new Error(`not found: session ${id}`)
    return row
  }

  sessionList(status: string | null, limit: number): SessionEntry[] {
    let sql = 'SELECT id, name, description, status, created_at, updated_at FROM sessions'
    const params: unknown[] = []
    if (status) { sql += ' WHERE status = ?'; params.push(status) }
    sql += ' ORDER BY updated_at DESC LIMIT ?'
    params.push(limit)
    return this.db.prepare(sql).all(...params) as SessionEntry[]
  }

  sessionUpdate(id: string, status: string | null, name: string | null, description: string | null): { updated: boolean } {
    validateId(id, 'id')
    const existing = this.db.prepare('SELECT id FROM sessions WHERE id = ?').get(id)
    if (!existing) throw new Error(`not found: session ${id}`)
    if (status !== null) validateSessionStatus(status)
    const sets: string[] = ['updated_at = ?']
    const params: unknown[] = [now()]
    if (status !== null) { sets.push('status = ?'); params.push(status) }
    if (name !== null) { sets.push('name = ?'); params.push(name) }
    if (description !== null) { sets.push('description = ?'); params.push(description) }
    params.push(id)
    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    return { updated: true }
  }

  // ─── Events ───

  eventLog(sessionId: string | null, eventType: string, content: string, metadata: string): { id: number } {
    validateText(eventType, 'event_type', 256)
    validateText(content, 'content', MAX_TEXT_CHARS)
    const ts = now()
    const result = this.db.prepare(`
      INSERT INTO events (session_id, event_type, content, metadata, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, eventType, content, metadata, ts)
    return { id: Number(result.lastInsertRowid) }
  }

  eventList(sessionId: string | null, eventType: string | null, limit: number): EventEntry[] {
    let sql = 'SELECT id, session_id, event_type, content, metadata, created_at FROM events'
    const conditions: string[] = []
    const params: unknown[] = []
    if (sessionId) { conditions.push('session_id = ?'); params.push(sessionId) }
    if (eventType) { conditions.push('event_type = ?'); params.push(eventType) }
    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ')
    sql += ' ORDER BY created_at DESC LIMIT ?'
    params.push(limit)
    return this.db.prepare(sql).all(...params) as EventEntry[]
  }

  eventSearch(query: string, sessionId: string | null, topK: number, raw: boolean): SearchResult[] {
    validateText(query, 'query', 10_000)
    const ftsQuery = raw ? query : toFtsQuery(query)
    let sql = `
      SELECT e.id, e.session_id, e.event_type,
             snippet(events_fts, 0, '<<', '>>', '…', 32) AS excerpt,
             -bm25(events_fts) AS score
      FROM events_fts JOIN events e ON e.id = events_fts.rowid
      WHERE events_fts MATCH ?
    `
    const params: unknown[] = [ftsQuery]
    if (sessionId) { sql += ' AND e.session_id = ?'; params.push(sessionId) }
    sql += ' ORDER BY score DESC LIMIT ?'
    params.push(topK)
    return this.db.prepare(sql).all(...params) as SearchResult[]
  }

  // ─── Stats ───

  stats(): { memory_count: number; doc_count: number; cache_count: number; todo_count: number; context_count: number; session_count: number; event_count: number; db_size_bytes: number } {
    const counts = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM memory) AS memory_count,
        (SELECT COUNT(*) FROM docs) AS doc_count,
        (SELECT COUNT(*) FROM cache) AS cache_count,
        (SELECT COUNT(*) FROM todos) AS todo_count,
        (SELECT COUNT(*) FROM context_entries) AS context_count,
        (SELECT COUNT(*) FROM sessions) AS session_count,
        (SELECT COUNT(*) FROM events) AS event_count
    `).get() as { memory_count: number; doc_count: number; cache_count: number; todo_count: number; context_count: number; session_count: number; event_count: number }
    const pageCount = this.db.prepare('PRAGMA page_count').get() as { page_count: number }
    const pageSize = this.db.prepare('PRAGMA page_size').get() as { page_size: number }
    return { ...counts, db_size_bytes: pageCount.page_count * pageSize.page_size }
  }
}

export { MAX_CONTENT_CHARS, MAX_TEXT_CHARS, MAX_IDENTIFIER_CHARS, MAX_TAGS, MAX_TAG_CHARS, DEFAULT_READ_LENGTH, DEFAULT_LIMIT, validateId, validateText, validateTags, toFtsQuery }
