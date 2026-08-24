import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDatabase, closeDatabase } from '../src/database.js'
import { Store } from '../src/store.js'
import { dispatch } from '../src/index.js'

interface RpcResponse {
  result?: { content?: { text: string }[]; isError?: boolean }
  error?: unknown
}

class InProcessMcp {
  private readonly store: Store
  private readonly db: ReturnType<typeof openDatabase>

  constructor(storageDir: string) {
    this.db = openDatabase(storageDir)
    this.store = new Store(this.db)
  }

  async call(_method: string, params: { name: string; arguments: Record<string, unknown> }): Promise<RpcResponse> {
    try {
      const result = dispatch(this.store, params.name, params.arguments ?? {})
      return { result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } }
    } catch (error) {
      return {
        result: {
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        },
      }
    }
  }

  async init(): Promise<void> {}

  close(): void {
    closeDatabase(this.db)
  }
}

function text(response: RpcResponse): string {
  return response.result?.content?.[0]?.text ?? ''
}

function parsed<T>(response: RpcResponse): T {
  return JSON.parse(text(response)) as T
}

describe('whimsicality-db', () => {
  let dir: string
  const servers: InProcessMcp[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'whim-db-test-'))
  })

  afterEach(() => {
    for (const server of servers) server.close()
    servers.length = 0
    try { rmSync(dir, { recursive: true, force: true }) } catch { }
  })

  function server(): InProcessMcp {
    const proc = new InProcessMcp(dir)
    servers.push(proc)
    return proc
  }

  async function readyServer(): Promise<InProcessMcp> {
    const proc = server()
    await proc.init()
    return proc
  }

  describe('memory', () => {
    it('stores and retrieves values', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_memory_set', arguments: { key: 'fact1', value: 'The sky is blue' } })
      const result = parsed<{ key: string; value: string }>(await mcp.call('tools/call', { name: 'db_memory_get', arguments: { key: 'fact1' } }))
      expect(result.value).toBe('The sky is blue')
    })

    it('isolates namespaces', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_memory_set', arguments: { key: 'k', value: 'ns1', namespace: 'alpha' } })
      await mcp.call('tools/call', { name: 'db_memory_set', arguments: { key: 'k', value: 'ns2', namespace: 'beta' } })
      const r1 = parsed<{ value: string }>(await mcp.call('tools/call', { name: 'db_memory_get', arguments: { key: 'k', namespace: 'alpha' } }))
      const r2 = parsed<{ value: string }>(await mcp.call('tools/call', { name: 'db_memory_get', arguments: { key: 'k', namespace: 'beta' } }))
      expect(r1.value).toBe('ns1')
      expect(r2.value).toBe('ns2')
    })

    it('deletes and reports correctly', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_memory_set', arguments: { key: 'temp', value: 'x' } })
      expect(parsed<{ deleted: boolean }>(await mcp.call('tools/call', { name: 'db_memory_delete', arguments: { key: 'temp' } })).deleted).toBe(true)
      expect(parsed<{ deleted: boolean }>(await mcp.call('tools/call', { name: 'db_memory_delete', arguments: { key: 'temp' } })).deleted).toBe(false)
    })

    it('returns isError for missing keys', async () => {
      const mcp = await readyServer()
      const response = await mcp.call('tools/call', { name: 'db_memory_get', arguments: { key: 'nope' } })
      expect(response.result?.isError).toBe(true)
    })
  })

  describe('entries (unified store)', () => {
    it('saves and reads small text', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_entry_save', arguments: { id: 'doc1', text: 'Hello world', title: 'Greeting' } })
      const result = parsed<{ content: string; title: string; compressed: boolean }>(await mcp.call('tools/call', { name: 'db_entry_read', arguments: { id: 'doc1' } }))
      expect(result.content).toBe('Hello world')
      expect(result.title).toBe('Greeting')
      expect(result.compressed).toBe(false)
    })

    it('auto-compresses large content', async () => {
      const mcp = await readyServer()
      const content = 'The quick brown fox jumps over the lazy dog. '.repeat(2000)
      const storeResult = parsed<{ id: string; size: number; stored: number; ratio: number }>(await mcp.call('tools/call', { name: 'db_entry_save', arguments: { id: 'big', text: content, title: 'Repeated fox' } }))
      expect(storeResult.size).toBeGreaterThan(storeResult.stored)
      expect(storeResult.ratio).toBeLessThan(0.5)
      const readResult = parsed<{ content: string; compressed: boolean; total: number; more: boolean }>(await mcp.call('tools/call', { name: 'db_entry_read', arguments: { id: 'big', length: content.length } }))
      expect(readResult.content).toBe(content)
      expect(readResult.compressed).toBe(true)
      expect(readResult.more).toBe(false)
    })

    it('pages large content', async () => {
      const mcp = await readyServer()
      const content = '0123456789'.repeat(1000)
      await mcp.call('tools/call', { name: 'db_entry_save', arguments: { id: 'paged', text: content, title: 'paged', compress: true } })
      const page1 = parsed<{ content: string; more: boolean }>(await mcp.call('tools/call', { name: 'db_entry_read', arguments: { id: 'paged', offset: 0, length: 100 } }))
      expect(page1.content).toBe(content.slice(0, 100))
      expect(page1.more).toBe(true)
      const page2 = parsed<{ content: string; more: boolean }>(await mcp.call('tools/call', { name: 'db_entry_read', arguments: { id: 'paged', offset: 9900, length: 200 } }))
      expect(page2.content).toBe(content.slice(9900))
      expect(page2.more).toBe(false)
    })

    it('stores and filters by tags', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_entry_save', arguments: { id: 'a', text: 'auth content', title: 'Auth', tags: ['security', 'auth'] } })
      await mcp.call('tools/call', { name: 'db_entry_save', arguments: { id: 'b', text: 'db content', title: 'DB', tags: ['database', 'infra'] } })
      await mcp.call('tools/call', { name: 'db_entry_save', arguments: { id: 'c', text: 'api content', title: 'API', tags: ['security', 'api'] } })
      const byTag = parsed<{ results: { id: string }[] }>(await mcp.call('tools/call', { name: 'db_entry_by_tags', arguments: { tags: ['security'] } }))
      expect(byTag.results.length).toBe(2)
      const ids = byTag.results.map((r) => r.id)
      expect(ids).toContain('a')
      expect(ids).toContain('c')
      const listFiltered = parsed<{ results: { id: string }[] }>(await mcp.call('tools/call', { name: 'db_entry_list', arguments: { tag: 'auth' } }))
      expect(listFiltered.results.length).toBe(1)
      expect(listFiltered.results[0]?.id).toBe('a')
    })

    it('updates entries and replaces tags', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_entry_save', arguments: { id: 'e', text: 'content', title: 'T', tags: ['old'] } })
      await mcp.call('tools/call', { name: 'db_entry_save', arguments: { id: 'e', text: 'content', title: 'T', tags: ['new'] } })
      const oldResult = parsed<{ results: { id: string }[] }>(await mcp.call('tools/call', { name: 'db_entry_list', arguments: { tag: 'old' } }))
      expect(oldResult.results.length).toBe(0)
      const newResult = parsed<{ results: { id: string }[] }>(await mcp.call('tools/call', { name: 'db_entry_list', arguments: { tag: 'new' } }))
      expect(newResult.results[0]?.id).toBe('e')
    })

    it('deletes entries', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_entry_save', arguments: { id: 'temp', text: 'x' } })
      expect(parsed<{ deleted: boolean }>(await mcp.call('tools/call', { name: 'db_entry_delete', arguments: { id: 'temp' } })).deleted).toBe(true)
      expect(parsed<{ deleted: boolean }>(await mcp.call('tools/call', { name: 'db_entry_delete', arguments: { id: 'temp' } })).deleted).toBe(false)
    })

    it('preserves source field', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_entry_save', arguments: { id: 'arch', text: 'We chose SQLite', title: 'Decision', source: 'design-meeting' } })
      const result = parsed<{ source: string }>(await mcp.call('tools/call', { name: 'db_entry_read', arguments: { id: 'arch' } }))
      expect(result.source).toBe('design-meeting')
    })
  })

  describe('todos', () => {
    it('adds, lists, updates, and deletes todos', async () => {
      const mcp = await readyServer()
      const addResult = parsed<{ id: number }>(await mcp.call('tools/call', { name: 'db_todo_add', arguments: { title: 'Build feature', priority: 50, tags: ['backend', 'urgent'] } }))
      expect(addResult.id).toBeGreaterThan(0)
      const listResult = parsed<{ results: { id: number; title: string; status: string; tags: string[] }[] }>(await mcp.call('tools/call', { name: 'db_todo_list', arguments: {} }))
      expect(listResult.results[0]?.title).toBe('Build feature')
      expect(listResult.results[0]?.status).toBe('pending')
      expect(listResult.results[0]?.tags).toContain('urgent')
      await mcp.call('tools/call', { name: 'db_todo_update', arguments: { id: addResult.id, status: 'in_progress' } })
      const updated = parsed<{ results: { status: string }[] }>(await mcp.call('tools/call', { name: 'db_todo_list', arguments: { status: 'in_progress' } }))
      expect(updated.results[0]?.status).toBe('in_progress')
      expect(parsed<{ deleted: boolean }>(await mcp.call('tools/call', { name: 'db_todo_delete', arguments: { id: addResult.id } })).deleted).toBe(true)
    })

    it('filters by tag', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_todo_add', arguments: { title: 'Task A', tags: ['frontend'] } })
      await mcp.call('tools/call', { name: 'db_todo_add', arguments: { title: 'Task B', tags: ['backend'] } })
      const result = parsed<{ results: { title: string }[] }>(await mcp.call('tools/call', { name: 'db_todo_list', arguments: { tag: 'frontend' } }))
      expect(result.results.length).toBe(1)
      expect(result.results[0]?.title).toBe('Task A')
    })

    it('clears description with empty string', async () => {
      const mcp = await readyServer()
      const addResult = parsed<{ id: number }>(await mcp.call('tools/call', { name: 'db_todo_add', arguments: { title: 'Test', description: 'Original' } }))
      await mcp.call('tools/call', { name: 'db_todo_update', arguments: { id: addResult.id, description: '' } })
      const list = parsed<{ results: { description: string }[] }>(await mcp.call('tools/call', { name: 'db_todo_list', arguments: {} }))
      expect(list.results[0]?.description).toBe('')
    })
  })

  describe('sessions and events', () => {
    it('creates sessions and logs events', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_session_create', arguments: { id: 'task-1', name: 'Build MCP server' } })
      const session = parsed<{ id: string; name: string; status: string }>(await mcp.call('tools/call', { name: 'db_session_list', arguments: { id: 'task-1' } }))
      expect(session.name).toBe('Build MCP server')
      expect(session.status).toBe('active')
      await mcp.call('tools/call', { name: 'db_event_log', arguments: { sid: 'task-1', type: 'decision', content: 'Chose SQLite' } })
      await mcp.call('tools/call', { name: 'db_event_log', arguments: { sid: 'task-1', type: 'milestone', content: 'Schema done' } })
      const events = parsed<{ results: { type: string }[] }>(await mcp.call('tools/call', { name: 'db_event_list', arguments: { sid: 'task-1' } }))
      expect(events.results.length).toBe(2)
    })

    it('updates session status', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_session_create', arguments: { id: 's1', name: 'Task' } })
      await mcp.call('tools/call', { name: 'db_session_update', arguments: { id: 's1', status: 'completed' } })
      const session = parsed<{ status: string }>(await mcp.call('tools/call', { name: 'db_session_list', arguments: { id: 's1' } }))
      expect(session.status).toBe('completed')
    })

    it('lists sessions by status', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_session_create', arguments: { id: 's1', name: 'Active' } })
      await mcp.call('tools/call', { name: 'db_session_create', arguments: { id: 's2', name: 'Done' } })
      await mcp.call('tools/call', { name: 'db_session_update', arguments: { id: 's2', status: 'completed' } })
      const active = parsed<{ results: { id: string }[] }>(await mcp.call('tools/call', { name: 'db_session_list', arguments: { status: 'active' } }))
      const completed = parsed<{ results: { id: string }[] }>(await mcp.call('tools/call', { name: 'db_session_list', arguments: { status: 'completed' } }))
      expect(active.results.map((r) => r.id)).toContain('s1')
      expect(completed.results.map((r) => r.id)).toContain('s2')
    })

    it('clears session description with empty string', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_session_create', arguments: { id: 's1', name: 'Test', description: 'Original' } })
      await mcp.call('tools/call', { name: 'db_session_update', arguments: { id: 's1', description: '' } })
      const session = parsed<{ description: string }>(await mcp.call('tools/call', { name: 'db_session_list', arguments: { id: 's1' } }))
      expect(session.description).toBe('')
    })
  })

  describe('unified search', () => {
    it('searches across memory and entries', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_memory_set', arguments: { key: 'fact', value: 'the rust kernel provides persistent storage' } })
      await mcp.call('tools/call', { name: 'db_entry_save', arguments: { id: 'doc', text: 'rust is a systems language for kernels', title: 'Rust' } })
      const result = parsed<{ results: { collection: string; id: string; score: number }[] }>(await mcp.call('tools/call', { name: 'db_search', arguments: { query: 'rust kernel' } }))
      expect(result.results.length).toBeGreaterThan(0)
      const collections = result.results.map((r) => r.collection)
      expect(collections).toContain('memory')
      expect(collections).toContain('entries')
    })

    it('filters by collection', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_memory_set', arguments: { key: 'fact', value: 'rust kernel storage' } })
      await mcp.call('tools/call', { name: 'db_entry_save', arguments: { id: 'doc', text: 'rust kernel storage', title: 'Rust' } })
      const result = parsed<{ results: { collection: string }[] }>(await mcp.call('tools/call', { name: 'db_search', arguments: { query: 'rust kernel', collections: ['memory'] } }))
      expect(result.results.every((r) => r.collection === 'memory')).toBe(true)
    })

    it('returns positive scores (higher = better)', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_memory_set', arguments: { key: 'exact', value: 'rust kernel storage' } })
      const result = parsed<{ results: { score: number }[] }>(await mcp.call('tools/call', { name: 'db_search', arguments: { query: 'rust kernel storage', collections: ['memory'] } }))
      expect(result.results.length).toBeGreaterThan(0)
      for (const r of result.results) expect(r.score).toBeGreaterThanOrEqual(0)
    })

    it('entry excerpt is match-centered', async () => {
      const mcp = await readyServer()
      const padding = 'word '.repeat(500)
      const text = `${padding}unique_marker_xyz${' word'.repeat(500)}`
      await mcp.call('tools/call', { name: 'db_entry_save', arguments: { id: 'doc', text, title: 'Long doc' } })
      const result = parsed<{ results: { collection: string; excerpt: string }[] }>(await mcp.call('tools/call', { name: 'db_search', arguments: { query: 'unique_marker_xyz', collections: ['entries'] } }))
      expect(result.results[0]?.excerpt).toContain('unique_marker_xyz')
      expect(result.results[0]?.excerpt.length).toBeLessThan(500)
    })
  })

  describe('FTS5 query escaping — nasty queries', () => {
    const nastyQueries = [
      "what's the plan?", 'C++', 'C#', 'plan AND', 'rust OR', 'NOT this',
      'a AND b', 'a OR b', 'a NOT b', 'term*', '"quoted"', 'col:value',
      'a^b', '(grouped)', 'a-b-c', "don't", "it's", 'path/to/file',
      'http://example.com', 'email@test.com', '100% done', 'a+b=c',
      'multi   space', '   leading', 'trailing   ', '日本語 テスト',
      'über café', 'naïve approach', "won't break", "can't stop won't stop",
    ]

    for (const query of nastyQueries) {
      it(`handles query: ${JSON.stringify(query)}`, async () => {
        const mcp = await readyServer()
        await mcp.call('tools/call', { name: 'db_memory_set', arguments: { key: 'k1', value: 'the system processes data from the rust kernel' } })
        await mcp.call('tools/call', { name: 'db_memory_set', arguments: { key: 'k2', value: 'a plan for C++ development with café access' } })
        const response = await mcp.call('tools/call', { name: 'db_search', arguments: { query, collections: ['memory'] } })
        expect(response.result?.isError).not.toBe(true)
        const result = parsed<{ results: unknown[] }>(response)
        expect(Array.isArray(result.results)).toBe(true)
      })
    }

    it('returns isError for query with no searchable terms', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_memory_set', arguments: { key: 'k', value: 'some content' } })
      const response = await mcp.call('tools/call', { name: 'db_search', arguments: { query: '!!! ??? ...', collections: ['memory'] } })
      expect(response.result?.isError).toBe(true)
    })

    it('supports raw FTS5 operator syntax', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_memory_set', arguments: { key: 'k1', value: 'rust kernel storage system' } })
      await mcp.call('tools/call', { name: 'db_memory_set', arguments: { key: 'k2', value: 'python web framework' } })
      const response = await mcp.call('tools/call', { name: 'db_search', arguments: { query: 'rust AND kernel', collections: ['memory'], raw: true } })
      expect(response.result?.isError).not.toBe(true)
      const result = parsed<{ results: { id: string }[] }>(response)
      expect(result.results.length).toBeGreaterThan(0)
      expect(result.results[0]?.id).toBe('k1')
    })
  })

  describe('status validation', () => {
    it('rejects invalid todo status', async () => {
      const mcp = await readyServer()
      const addResult = parsed<{ id: number }>(await mcp.call('tools/call', { name: 'db_todo_add', arguments: { title: 'Test' } }))
      const response = await mcp.call('tools/call', { name: 'db_todo_update', arguments: { id: addResult.id, status: 'done' } })
      expect(response.result?.isError).toBe(true)
    })

    it('rejects invalid session status', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_session_create', arguments: { id: 's1', name: 'Test' } })
      const response = await mcp.call('tools/call', { name: 'db_session_update', arguments: { id: 's1', status: 'finished' } })
      expect(response.result?.isError).toBe(true)
    })

    it('accepts all valid todo statuses', async () => {
      const mcp = await readyServer()
      const addResult = parsed<{ id: number }>(await mcp.call('tools/call', { name: 'db_todo_add', arguments: { title: 'Test' } }))
      for (const status of ['pending', 'in_progress', 'completed']) {
        const response = await mcp.call('tools/call', { name: 'db_todo_update', arguments: { id: addResult.id, status } })
        expect(response.result?.isError).not.toBe(true)
      }
    })

    it('accepts all valid session statuses', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_session_create', arguments: { id: 's1', name: 'Test' } })
      for (const status of ['active', 'paused', 'completed', 'abandoned']) {
        const response = await mcp.call('tools/call', { name: 'db_session_update', arguments: { id: 's1', status } })
        expect(response.result?.isError).not.toBe(true)
      }
    })
  })

  describe('validation', () => {
    it('rejects missing required arguments', async () => {
      const mcp = await readyServer()
      const response = await mcp.call('tools/call', { name: 'db_memory_set', arguments: { key: 'k' } })
      expect(response.result?.isError).toBe(true)
    })

    it('rejects over-length tags', async () => {
      const mcp = await readyServer()
      const response = await mcp.call('tools/call', { name: 'db_todo_add', arguments: { title: 'test', tags: ['x'.repeat(300)] } })
      expect(response.result?.isError).toBe(true)
    })

    it('rejects too many tags', async () => {
      const mcp = await readyServer()
      const response = await mcp.call('tools/call', { name: 'db_entry_save', arguments: { id: 'e', text: 't', tags: Array.from({ length: 25 }, (_, i) => `tag${i}`) } })
      expect(response.result?.isError).toBe(true)
    })
  })

  describe('stats and cross-process', () => {
    it('returns database stats', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_memory_set', arguments: { key: 'k', value: 'v' } })
      await mcp.call('tools/call', { name: 'db_entry_save', arguments: { id: 'e', text: 'content' } })
      await mcp.call('tools/call', { name: 'db_todo_add', arguments: { title: 'Todo' } })
      await mcp.call('tools/call', { name: 'db_session_create', arguments: { id: 's', name: 'Session' } })
      await mcp.call('tools/call', { name: 'db_event_log', arguments: { type: 'note', content: 'event' } })
      const stats = parsed<{ memory: number; entries: number; todos: number; sessions: number; events: number; db_bytes: number }>(await mcp.call('tools/call', { name: 'db_stats', arguments: {} }))
      expect(stats.memory).toBe(1)
      expect(stats.entries).toBe(1)
      expect(stats.todos).toBe(1)
      expect(stats.sessions).toBe(1)
      expect(stats.events).toBe(1)
      expect(stats.db_bytes).toBeGreaterThan(0)
    })

    it('makes writes visible to another process', async () => {
      const a = await readyServer()
      const b = await readyServer()
      await a.call('tools/call', { name: 'db_memory_set', arguments: { key: 'shared', value: 'cross-process' } })
      const result = parsed<{ value: string }>(await b.call('tools/call', { name: 'db_memory_get', arguments: { key: 'shared' } }))
      expect(result.value).toBe('cross-process')
    })
  })

  describe('import from whimsicality-mcp', () => {
    it('imports memory and docs from JSON store', async () => {
      const mcp = await readyServer()
      const sourceDir = mkdtempSync(join(tmpdir(), 'whim-mcp-src-'))
      try {
        writeFileSync(join(sourceDir, 'memory.json'), JSON.stringify({
          default: { fact1: { value: 'imported fact', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' } },
          alpha: { key1: { value: 'namespaced', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' } },
        }))
        writeFileSync(join(sourceDir, 'docs.json'), JSON.stringify({
          doc1: { text: 'imported document text', language: 'text', description: 'Test doc', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' },
        }))
        const result = parsed<{ memory: number; entries: number; errors: string[] }>(await mcp.call('tools/call', { name: 'db_import', arguments: { path: sourceDir } }))
        expect(result.memory).toBe(2)
        expect(result.entries).toBe(1)
        expect(result.errors.length).toBe(0)
        const memResult = parsed<{ value: string }>(await mcp.call('tools/call', { name: 'db_memory_get', arguments: { key: 'fact1' } }))
        expect(memResult.value).toBe('imported fact')
        const entryResult = parsed<{ content: string; title: string }>(await mcp.call('tools/call', { name: 'db_entry_read', arguments: { id: 'doc1' } }))
        expect(entryResult.content).toBe('imported document text')
        expect(entryResult.title).toBe('Test doc')
      } finally {
        try { rmSync(sourceDir, { recursive: true, force: true }) } catch { }
      }
    })
  })
})
