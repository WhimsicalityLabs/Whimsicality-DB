import type Database from 'better-sqlite3'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const now = (): string => new Date().toISOString()

export interface MemoryEntry { key: string; namespace: string; value: string; created_at: string; updated_at: string }
export interface EntryRecord { entry_id: string; title: string; is_compressed: boolean; original_size: number; source: string; tags: string[]; created_at: string; updated_at: string }
export interface TodoEntry { id: number; title: string; description: string; status: string; priority: number; tags: string[]; session_id: string | null; created_at: string; updated_at: string }
export interface SessionEntry { id: string; name: string; description: string; status: string; created_at: string; updated_at: string }
export interface EventEntry { id: number; session_id: string | null; event_type: string; content: string; metadata: string; created_at: string }

export interface SearchResult { collection: string; id: string | number; score: number; [key: string]: unknown }

const MAX_CONTENT_CHARS = 5_000_000
const MAX_TEXT_CHARS = 1_000_000
const MAX_IDENTIFIER_CHARS = 256
const MAX_TAGS = 20
const MAX_TAG_CHARS = 256
const DEFAULT_READ_LENGTH = 8_000
const DEFAULT_LIMIT = 100
const COMPRESS_THRESHOLD = 65_536

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

export function toFtsQuery(raw: string): string {
  const terms = raw.match(/[\p{L}\p{N}_]+/gu) ?? []
  if (terms.length === 0) throw new Error('query has no searchable terms')
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')
}

export class Store {
  private readonly db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  private syncEntryTags(entryId: number, tags: string[]): void {
    this.db.prepare('DELETE FROM entry_tags WHERE entry_id = ?').run(entryId)
    const insert = this.db.prepare('INSERT INTO entry_tags (entry_id, tag) VALUES (?, ?)')
    for (const tag of tags) insert.run(entryId, tag)
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

  // ─── Entries (unified: docs + cache + context) ───

  entrySave(entryId: string, text: string, title: string, tags: string[], source: string, compress: boolean | null): { id: string; original_size: number; compressed_size: number; ratio: number } {
    validateId(entryId, 'id')
    validateText(text, 'text', MAX_CONTENT_CHARS)
    const shouldCompress = compress === true || (compress === null && text.length > COMPRESS_THRESHOLD)
    const ts = now()
    const originalSize = Buffer.byteLength(text, 'utf-8')
    let contentBlob: Buffer | null = null
    let contentText: string = text
    let compressedSize = originalSize
    if (shouldCompress) {
      contentBlob = brotliCompressSync(Buffer.from(text, 'utf-8'))
      compressedSize = contentBlob.length
      contentText = title || text.slice(0, 200)
    }
    const tx = this.db.transaction(() => {
      const result = this.db.prepare(`
        INSERT INTO entries (entry_id, title, content, content_text, is_compressed, original_size, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entry_id) DO UPDATE SET title = excluded.title, content = excluded.content, content_text = excluded.content_text, is_compressed = excluded.is_compressed, original_size = excluded.original_size, source = excluded.source, updated_at = excluded.updated_at
      `).run(entryId, title, contentBlob, contentText, shouldCompress ? 1 : 0, originalSize, source, ts, ts)
      const rowId = Number(result.lastInsertRowid)
      this.syncEntryTags(rowId, tags)
    })
    tx()
    return { id: entryId, original_size: originalSize, compressed_size: compressedSize, ratio: originalSize > 0 ? compressedSize / originalSize : 0 }
  }

  entryRead(entryId: string, offset: number, length: number): { content: string; title: string; is_compressed: boolean; tags: string[]; source: string; offset: number; length: number; total_length: number; has_more: boolean } {
    validateId(entryId, 'id')
    const row = this.db.prepare('SELECT content, content_text, is_compressed, title, source, original_size FROM entries WHERE entry_id = ?').get(entryId) as { content: Buffer | null; content_text: string | null; is_compressed: number; title: string; source: string; original_size: number } | undefined
    if (!row) throw new Error(`not found: ${entryId}`)
    const fullContent = row.is_compressed ? brotliDecompressSync(row.content!).toString('utf-8') : (row.content_text ?? '')
    const totalLength = fullContent.length
    const start = Math.max(0, Math.min(offset, totalLength))
    const end = Math.min(start + length, totalLength)
    const tagRows = this.db.prepare('SELECT tag FROM entry_tags WHERE entry_id = (SELECT id FROM entries WHERE entry_id = ?)').all(entryId) as { tag: string }[]
    return {
      content: fullContent.slice(start, end),
      title: row.title,
      is_compressed: row.is_compressed === 1,
      tags: tagRows.map((t) => t.tag),
      source: row.source,
      offset: start,
      length: end - start,
      total_length: totalLength,
      has_more: end < totalLength,
    }
  }

  entryList(tagFilter: string | null, limit: number): { results: EntryRecord[] } {
    let sql = 'SELECT DISTINCT e.entry_id, e.title, e.is_compressed, e.original_size, e.source, e.created_at, e.updated_at FROM entries e'
    const params: unknown[] = []
    if (tagFilter) {
      sql += ' JOIN entry_tags et ON et.entry_id = e.id WHERE et.tag = ?'
      params.push(tagFilter)
    }
    sql += ' ORDER BY e.updated_at DESC LIMIT ?'
    params.push(limit)
    const rows = this.db.prepare(sql).all(...params) as { entry_id: string; title: string; is_compressed: number; original_size: number; source: string; created_at: string; updated_at: string }[]
    const result: EntryRecord[] = []
    for (const r of rows) {
      const tagRows = this.db.prepare('SELECT tag FROM entry_tags WHERE entry_id = (SELECT id FROM entries WHERE entry_id = ?)').all(r.entry_id) as { tag: string }[]
      result.push({ entry_id: r.entry_id, title: r.title, is_compressed: r.is_compressed === 1, original_size: r.original_size, source: r.source, created_at: r.created_at, updated_at: r.updated_at, tags: tagRows.map((t) => t.tag) })
    }
    return { results: result }
  }

  entryByTags(tags: string[], limit: number): EntryRecord[] {
    if (tags.length === 0) throw new Error('at least one tag required')
    const placeholders = tags.map(() => '?').join(', ')
    const rows = this.db.prepare(`
      SELECT DISTINCT e.entry_id, e.title, e.is_compressed, e.original_size, e.source, e.created_at, e.updated_at
      FROM entries e
      JOIN entry_tags et ON et.entry_id = e.id
      WHERE et.tag IN (${placeholders})
      ORDER BY e.updated_at DESC LIMIT ?
    `).all(...tags, limit) as { entry_id: string; title: string; is_compressed: number; original_size: number; source: string; created_at: string; updated_at: string }[]
    const result: EntryRecord[] = []
    for (const r of rows) {
      const tagRows = this.db.prepare('SELECT tag FROM entry_tags WHERE entry_id = (SELECT id FROM entries WHERE entry_id = ?)').all(r.entry_id) as { tag: string }[]
      result.push({ entry_id: r.entry_id, title: r.title, is_compressed: r.is_compressed === 1, original_size: r.original_size, source: r.source, created_at: r.created_at, updated_at: r.updated_at, tags: tagRows.map((t) => t.tag) })
    }
    return result
  }

  entryDelete(entryId: string): { deleted: boolean } {
    validateId(entryId, 'id')
    const result = this.db.prepare('DELETE FROM entries WHERE entry_id = ?').run(entryId)
    return { deleted: result.changes > 0 }
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
      this.syncTodoTags(todoId, tags)
      return todoId
    })
    return { id: tx() }
  }

  private syncTodoTags(todoId: number, tags: string[]): void {
    this.db.prepare('DELETE FROM todo_tags WHERE todo_id = ?').run(todoId)
    const insert = this.db.prepare('INSERT INTO todo_tags (todo_id, tag) VALUES (?, ?)')
    for (const tag of tags) insert.run(todoId, tag)
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

  // ─── Unified Search ───

  search(query: string, collections: string[], topK: number, raw: boolean): SearchResult[] {
    validateText(query, 'query', 10_000)
    const ftsQuery = raw ? query : toFtsQuery(query)
    const results: SearchResult[] = []
    if (collections.includes('memory')) {
      const rows = this.db.prepare(`
        SELECT m.key AS id, 'memory' AS collection, m.namespace, m.value, -bm25(memory_fts) AS score
        FROM memory_fts JOIN memory m ON m.id = memory_fts.rowid
        WHERE memory_fts MATCH ?
        ORDER BY score DESC LIMIT ?
      `).all(ftsQuery, topK) as SearchResult[]
      results.push(...rows)
    }
    if (collections.includes('entries')) {
      const rows = this.db.prepare(`
        SELECT e.entry_id AS id, 'entries' AS collection, e.title,
               snippet(entries_fts, 1, '<<', '>>', '…', 48) AS excerpt,
               -bm25(entries_fts) AS score
        FROM entries_fts JOIN entries e ON e.id = entries_fts.rowid
        WHERE entries_fts MATCH ?
        ORDER BY score DESC LIMIT ?
      `).all(ftsQuery, topK) as SearchResult[]
      results.push(...rows)
    }
    if (collections.includes('todos')) {
      const rows = this.db.prepare(`
        SELECT t.id, 'todos' AS collection, t.title, t.status, -bm25(todos_fts) AS score
        FROM todos_fts JOIN todos t ON t.id = todos_fts.rowid
        WHERE todos_fts MATCH ?
        ORDER BY score DESC LIMIT ?
      `).all(ftsQuery, topK) as SearchResult[]
      results.push(...rows)
    }
    if (collections.includes('events')) {
      const rows = this.db.prepare(`
        SELECT e.id, 'events' AS collection, e.event_type,
               snippet(events_fts, 0, '<<', '>>', '…', 32) AS excerpt,
               -bm25(events_fts) AS score
        FROM events_fts JOIN events e ON e.id = events_fts.rowid
        WHERE events_fts MATCH ?
        ORDER BY score DESC LIMIT ?
      `).all(ftsQuery, topK) as SearchResult[]
      results.push(...rows)
    }
    return results.sort((a, b) => b.score - a.score).slice(0, topK)
  }

  // ─── Stats ───

  stats(): { memory_count: number; entry_count: number; todo_count: number; session_count: number; event_count: number; db_size_bytes: number } {
    const counts = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM memory) AS memory_count,
        (SELECT COUNT(*) FROM entries) AS entry_count,
        (SELECT COUNT(*) FROM todos) AS todo_count,
        (SELECT COUNT(*) FROM sessions) AS session_count,
        (SELECT COUNT(*) FROM events) AS event_count
    `).get() as { memory_count: number; entry_count: number; todo_count: number; session_count: number; event_count: number }
    const pageCount = this.db.prepare('PRAGMA page_count').get() as { page_count: number }
    const pageSize = this.db.prepare('PRAGMA page_size').get() as { page_size: number }
    return { ...counts, db_size_bytes: pageCount.page_count * pageSize.page_size }
  }

  // ─── Import from whimsicality-mcp ───

  importMcp(sourceDir: string): { memory: number; entries: number; errors: string[] } {
    const errors: string[] = []
    let memoryCount = 0
    let entryCount = 0
    const ts = now()

    const memoryPath = join(sourceDir, 'memory.json')
    if (existsSync(memoryPath)) {
      try {
        const memory = JSON.parse(readFileSync(memoryPath, 'utf-8')) as Record<string, Record<string, { value: string; created_at?: string; updated_at?: string }>>
        for (const [namespace, keys] of Object.entries(memory)) {
          for (const [key, entry] of Object.entries(keys)) {
            try {
              this.db.prepare(`
                INSERT OR IGNORE INTO memory (namespace, key, value, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
              `).run(namespace, key, entry.value, entry.created_at ?? ts, entry.updated_at ?? ts)
              memoryCount++
            } catch (e) { errors.push(`memory ${namespace}/${key}: ${e instanceof Error ? e.message : String(e)}`) }
          }
        }
      } catch (e) { errors.push(`memory.json: ${e instanceof Error ? e.message : String(e)}`) }
    }

    const docsPath = join(sourceDir, 'docs.json')
    if (existsSync(docsPath)) {
      try {
        const docs = JSON.parse(readFileSync(docsPath, 'utf-8')) as Record<string, { text: string; language?: string; description?: string; created_at?: string; updated_at?: string }>
        for (const [docId, doc] of Object.entries(docs)) {
          try {
            this.db.prepare(`
              INSERT OR IGNORE INTO entries (entry_id, title, content_text, is_compressed, original_size, source, created_at, updated_at)
              VALUES (?, ?, ?, 0, ?, ?, ?, ?)
            `).run(docId, doc.description ?? '', doc.text, doc.text.length, doc.language ?? '', doc.created_at ?? ts, doc.updated_at ?? ts)
            entryCount++
          } catch (e) { errors.push(`doc ${docId}: ${e instanceof Error ? e.message : String(e)}`) }
        }
      } catch (e) { errors.push(`docs.json: ${e instanceof Error ? e.message : String(e)}`) }
    }

    const cacheIndexPath = join(sourceDir, 'cache-index.json')
    if (existsSync(cacheIndexPath)) {
      try {
        const cacheIndex = JSON.parse(readFileSync(cacheIndexPath, 'utf-8')) as Record<string, { topic?: string; summary?: string; tags?: string[]; original_size?: number; compressed_size?: number; created_at?: string; updated_at?: string }>
        for (const [chunkId, meta] of Object.entries(cacheIndex)) {
          try {
            const hash = require('node:crypto').createHash('sha256').update(chunkId).digest('hex')
            const chunkPath = join(sourceDir, 'cache-chunks', `${hash}.br`)
            let contentBlob: Buffer | null = null
            if (existsSync(chunkPath)) {
              contentBlob = readFileSync(chunkPath)
            }
            this.db.prepare(`
              INSERT OR IGNORE INTO entries (entry_id, title, content, content_text, is_compressed, original_size, source, created_at, updated_at)
              VALUES (?, ?, ?, ?, 1, ?, '', ?, ?)
            `).run(chunkId, meta.summary ?? meta.topic ?? '', contentBlob, meta.topic ?? meta.summary ?? '', meta.original_size ?? 0, meta.created_at ?? ts, meta.updated_at ?? ts)
            if (meta.tags && Array.isArray(meta.tags)) {
              const rowId = this.db.prepare('SELECT id FROM entries WHERE entry_id = ?').get(chunkId) as { id: number } | undefined
              if (rowId) {
                for (const tag of meta.tags) {
                  if (typeof tag === 'string' && tag.length > 0) {
                    this.db.prepare('INSERT OR IGNORE INTO entry_tags (entry_id, tag) VALUES (?, ?)').run(rowId.id, tag)
                  }
                }
              }
            }
            entryCount++
          } catch (e) { errors.push(`cache ${chunkId}: ${e instanceof Error ? e.message : String(e)}`) }
        }
      } catch (e) { errors.push(`cache-index.json: ${e instanceof Error ? e.message : String(e)}`) }
    }

    return { memory: memoryCount, entries: entryCount, errors }
  }
}

export { MAX_CONTENT_CHARS, MAX_TEXT_CHARS, MAX_IDENTIFIER_CHARS, MAX_TAGS, MAX_TAG_CHARS, DEFAULT_READ_LENGTH, DEFAULT_LIMIT, validateId, validateText, validateTags }
