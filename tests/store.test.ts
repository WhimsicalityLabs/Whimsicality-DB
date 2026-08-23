import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
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

    it('searches with FTS5', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_memory_set', arguments: { key: 'common', value: 'the system processes data and results' } })
      await mcp.call('tools/call', { name: 'db_memory_set', arguments: { key: 'rare', value: 'the rust kernel provides persistent storage' } })
      const result = parsed<{ results: { id: string; score: number }[] }>(await mcp.call('tools/call', { name: 'db_memory_search', arguments: { query: 'rust kernel storage' } }))
      expect(result.results.length).toBeGreaterThan(0)
      expect(result.results[0]?.id).toBe('rare')
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

  describe('docs', () => {
    it('saves and retrieves documents', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_doc_save', arguments: { id: 'doc1', text: 'Hello world', language: 'text', description: 'test doc' } })
      const result = parsed<{ doc_id: string; text: string; language: string }>(await mcp.call('tools/call', { name: 'db_doc_get', arguments: { id: 'doc1' } }))
      expect(result.text).toBe('Hello world')
      expect(result.language).toBe('text')
    })

    it('searches with FTS5 and returns excerpts', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_doc_save', arguments: { id: 'doc', text: 'The needle_unique is found in this haystack of text' } })
      const result = parsed<{ results: { id: string; excerpt: string }[] }>(await mcp.call('tools/call', { name: 'db_doc_search', arguments: { query: 'needle_unique' } }))
      expect(result.results[0]?.id).toBe('doc')
      expect(result.results[0]?.excerpt).toContain('needle_unique')
    })
  })

  describe('cache', () => {
    it('stores, compresses, and reads content', async () => {
      const mcp = await readyServer()
      const content = 'The quick brown fox jumps over the lazy dog. '.repeat(500)
      const storeResult = parsed<{ id: string; original_size: number; compressed_size: number; ratio: number }>(await mcp.call('tools/call', { name: 'db_cache_store', arguments: { id: 'fox', content, topic: 'pangram', summary: 'Repeated fox sentence' } }))
      expect(storeResult.original_size).toBeGreaterThan(storeResult.compressed_size)
      expect(storeResult.ratio).toBeLessThan(0.5)
      const readResult = parsed<{ content: string; total_length: number; has_more: boolean }>(await mcp.call('tools/call', { name: 'db_cache_read', arguments: { id: 'fox', length: content.length } }))
      expect(readResult.content).toBe(content)
      expect(readResult.has_more).toBe(false)
    })

    it('pages large content', async () => {
      const mcp = await readyServer()
      const content = '0123456789'.repeat(1000)
      await mcp.call('tools/call', { name: 'db_cache_store', arguments: { id: 'paged', content, topic: 'test', summary: 'paged' } })
      const page1 = parsed<{ content: string; offset: number; length: number; total_length: number; has_more: boolean }>(await mcp.call('tools/call', { name: 'db_cache_read', arguments: { id: 'paged', offset: 0, length: 100 } }))
      expect(page1.content).toBe(content.slice(0, 100))
      expect(page1.has_more).toBe(true)
      const page2 = parsed<{ content: string; has_more: boolean }>(await mcp.call('tools/call', { name: 'db_cache_read', arguments: { id: 'paged', offset: 9900, length: 200 } }))
      expect(page2.content).toBe(content.slice(9900))
      expect(page2.has_more).toBe(false)
    })

    it('returns a compact index table with token estimate', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_cache_store', arguments: { id: 'a1', content: 'auth content', topic: 'auth', summary: 'JWT RS256' } })
      const result = parsed<{ table: string }>(await mcp.call('tools/call', { name: 'db_cache_index', arguments: {} }))
      expect(result.table).toContain('a1')
      expect(result.table).toMatch(/~\d+ tokens/)
    })

    it('searches cache with FTS5', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_cache_store', arguments: { id: 'auth', content: 'auth stuff', topic: 'authentication', summary: 'JWT RS256 signing', tags: ['security'] } })
      await mcp.call('tools/call', { name: 'db_cache_store', arguments: { id: 'db', content: 'db stuff', topic: 'database', summary: 'Postgres 16 pool config', tags: ['postgres'] } })
      const result = parsed<{ results: { id: string }[] }>(await mcp.call('tools/call', { name: 'db_cache_search', arguments: { query: 'jwt signing' } }))
      expect(result.results[0]?.id).toBe('auth')
    })
  })

  describe('todos', () => {
    it('adds, lists, updates, and deletes todos', async () => {
      const mcp = await readyServer()
      const addResult = parsed<{ id: number }>(await mcp.call('tools/call', { name: 'db_todo_add', arguments: { title: 'Build feature', priority: 50, tags: ['backend', 'urgent'] } }))
      expect(addResult.id).toBeGreaterThan(0)
      const listResult = parsed<{ results: { id: number; title: string; status: string; priority: number; tags: string[] }[] }>(await mcp.call('tools/call', { name: 'db_todo_list', arguments: {} }))
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

    it('searches todos with FTS5', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_todo_add', arguments: { title: 'Implement authentication system', description: 'Use JWT with RS256' } })
      await mcp.call('tools/call', { name: 'db_todo_add', arguments: { title: 'Fix database migration', description: 'Postgres schema update' } })
      const result = parsed<{ results: { title: string }[] }>(await mcp.call('tools/call', { name: 'db_todo_search', arguments: { query: 'authentication JWT' } }))
      expect(result.results[0]?.title).toContain('authentication')
    })
  })

  describe('context index', () => {
    it('adds and retrieves by ID', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_context_add', arguments: { entry_id: 'arch-1', title: 'Architecture Decision', content: 'We chose SQLite for persistence', tags: ['architecture', 'database'], source: 'design-meeting' } })
      const result = parsed<{ entry_id: string; title: string; content: string; tags: string[]; source: string }>(await mcp.call('tools/call', { name: 'db_context_get', arguments: { entry_id: 'arch-1' } }))
      expect(result.title).toBe('Architecture Decision')
      expect(result.tags).toContain('architecture')
      expect(result.source).toBe('design-meeting')
    })

    it('retrieves by tag', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_context_add', arguments: { entry_id: 'e1', title: 'Auth', content: 'JWT details', tags: ['security', 'auth'] } })
      await mcp.call('tools/call', { name: 'db_context_add', arguments: { entry_id: 'e2', title: 'DB', content: 'Postgres config', tags: ['database', 'infra'] } })
      await mcp.call('tools/call', { name: 'db_context_add', arguments: { entry_id: 'e3', title: 'API Security', content: 'Rate limiting', tags: ['security', 'api'] } })
      const result = parsed<{ results: { entry_id: string; title: string }[] }>(await mcp.call('tools/call', { name: 'db_context_by_tags', arguments: { tags: ['security'] } }))
      expect(result.results.length).toBe(2)
      const ids = result.results.map((r) => r.entry_id)
      expect(ids).toContain('e1')
      expect(ids).toContain('e3')
    })

    it('searches with FTS5', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_context_add', arguments: { entry_id: 'r1', title: 'Rust patterns', content: 'Use tokio for async runtime and Arc for shared state', tags: ['rust'] } })
      const result = parsed<{ results: { id: string; title: string }[] }>(await mcp.call('tools/call', { name: 'db_context_search', arguments: { query: 'tokio async runtime' } }))
      expect(result.results[0]?.id).toBe('r1')
    })
  })

  describe('sessions and events', () => {
    it('creates sessions and logs events', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_session_create', arguments: { id: 'task-1', name: 'Build MCP server', description: 'Long-running task' } })
      const session = parsed<{ id: string; name: string; status: string }>(await mcp.call('tools/call', { name: 'db_session_get', arguments: { id: 'task-1' } }))
      expect(session.name).toBe('Build MCP server')
      expect(session.status).toBe('active')
      await mcp.call('tools/call', { name: 'db_event_log', arguments: { session_id: 'task-1', event_type: 'decision', content: 'Chose SQLite over JSON file storage' } })
      await mcp.call('tools/call', { name: 'db_event_log', arguments: { session_id: 'task-1', event_type: 'milestone', content: 'Database schema implemented' } })
      const events = parsed<{ results: { event_type: string; content: string }[] }>(await mcp.call('tools/call', { name: 'db_event_list', arguments: { session_id: 'task-1' } }))
      expect(events.results.length).toBe(2)
    })

    it('searches events with FTS5', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_session_create', arguments: { id: 's1', name: 'Test session' } })
      await mcp.call('tools/call', { name: 'db_event_log', arguments: { session_id: 's1', event_type: 'note', content: 'The rust kernel approach was abandoned' } })
      await mcp.call('tools/call', { name: 'db_event_log', arguments: { session_id: 's1', event_type: 'note', content: 'Switched to pure TypeScript implementation' } })
      const result = parsed<{ results: { event_type: string; excerpt: string }[] }>(await mcp.call('tools/call', { name: 'db_event_search', arguments: { query: 'rust kernel abandoned', session_id: 's1' } }))
      expect(result.results.length).toBeGreaterThan(0)
      expect(result.results[0]?.excerpt).toContain('rust')
    })

    it('updates session status', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_session_create', arguments: { id: 's1', name: 'Task' } })
      await mcp.call('tools/call', { name: 'db_session_update', arguments: { id: 's1', status: 'completed' } })
      const session = parsed<{ status: string }>(await mcp.call('tools/call', { name: 'db_session_get', arguments: { id: 's1' } }))
      expect(session.status).toBe('completed')
    })

    it('lists sessions by status', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_session_create', arguments: { id: 's1', name: 'Active task' } })
      await mcp.call('tools/call', { name: 'db_session_create', arguments: { id: 's2', name: 'Done task' } })
      await mcp.call('tools/call', { name: 'db_session_update', arguments: { id: 's2', status: 'completed' } })
      const active = parsed<{ results: { id: string }[] }>(await mcp.call('tools/call', { name: 'db_session_list', arguments: { status: 'active' } }))
      const completed = parsed<{ results: { id: string }[] }>(await mcp.call('tools/call', { name: 'db_session_list', arguments: { status: 'completed' } }))
      expect(active.results.map((r) => r.id)).toContain('s1')
      expect(completed.results.map((r) => r.id)).toContain('s2')
    })
  })

  describe('stats and cross-process', () => {
    it('returns database stats', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_memory_set', arguments: { key: 'k', value: 'v' } })
      await mcp.call('tools/call', { name: 'db_doc_save', arguments: { id: 'd', text: 'doc' } })
      await mcp.call('tools/call', { name: 'db_cache_store', arguments: { id: 'c', content: 'cache', topic: 't', summary: 's' } })
      await mcp.call('tools/call', { name: 'db_todo_add', arguments: { title: 'Todo' } })
      await mcp.call('tools/call', { name: 'db_context_add', arguments: { entry_id: 'ctx', title: 'Ctx', content: 'content' } })
      await mcp.call('tools/call', { name: 'db_session_create', arguments: { id: 'sess', name: 'Session' } })
      await mcp.call('tools/call', { name: 'db_event_log', arguments: { event_type: 'note', content: 'event' } })
      const stats = parsed<{ memory_count: number; doc_count: number; cache_count: number; todo_count: number; context_count: number; session_count: number; event_count: number; db_size_bytes: number }>(await mcp.call('tools/call', { name: 'db_stats', arguments: {} }))
      expect(stats.memory_count).toBe(1)
      expect(stats.doc_count).toBe(1)
      expect(stats.cache_count).toBe(1)
      expect(stats.todo_count).toBe(1)
      expect(stats.context_count).toBe(1)
      expect(stats.session_count).toBe(1)
      expect(stats.event_count).toBe(1)
      expect(stats.db_size_bytes).toBeGreaterThan(0)
    })

    it('makes writes visible to another process', async () => {
      const a = await readyServer()
      const b = await readyServer()
      await a.call('tools/call', { name: 'db_memory_set', arguments: { key: 'shared', value: 'cross-process' } })
      const result = parsed<{ value: string }>(await b.call('tools/call', { name: 'db_memory_get', arguments: { key: 'shared' } }))
      expect(result.value).toBe('cross-process')
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
      const response = await mcp.call('tools/call', { name: 'db_context_add', arguments: { entry_id: 'e', title: 't', content: 'c', tags: Array.from({ length: 25 }, (_, i) => `tag${i}`) } })
      expect(response.result?.isError).toBe(true)
    })
  })

  describe('FTS5 query escaping — nasty queries', () => {
    const nastyQueries = [
      "what's the plan?",
      'C++',
      'C#',
      'plan AND',
      'rust OR',
      'NOT this',
      'a AND b',
      'a OR b',
      'a NOT b',
      'term*',
      '"quoted"',
      'col:value',
      'a^b',
      '(grouped)',
      'a-b-c',
      "don't",
      "it's",
      'path/to/file',
      'http://example.com',
      'email@test.com',
      '100% done',
      'a+b=c',
      'multi   space',
      '   leading',
      'trailing   ',
      '日本語 テスト',
      'über café',
      'naïve approach',
      "won't break",
      "can't stop won't stop",
    ]

    for (const query of nastyQueries) {
      it(`handles query: ${JSON.stringify(query)}`, async () => {
        const mcp = await readyServer()
        await mcp.call('tools/call', { name: 'db_memory_set', arguments: { key: 'k1', value: 'the system processes data and results from the rust kernel' } })
        await mcp.call('tools/call', { name: 'db_memory_set', arguments: { key: 'k2', value: 'a plan for C++ development with café access' } })
        const response = await mcp.call('tools/call', { name: 'db_memory_search', arguments: { query } })
        expect(response.result?.isError).not.toBe(true)
        const result = parsed<{ results: unknown[] }>(response)
        expect(Array.isArray(result.results)).toBe(true)
      })
    }

    it('returns isError for query with no searchable terms', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_memory_set', arguments: { key: 'k', value: 'some content' } })
      const response = await mcp.call('tools/call', { name: 'db_memory_search', arguments: { query: '!!! ??? ...' } })
      expect(response.result?.isError).toBe(true)
    })

    it('supports raw FTS5 operator syntax with raw:true', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_memory_set', arguments: { key: 'k1', value: 'rust kernel storage system' } })
      await mcp.call('tools/call', { name: 'db_memory_set', arguments: { key: 'k2', value: 'python web framework' } })
      const response = await mcp.call('tools/call', { name: 'db_memory_search', arguments: { query: 'rust AND kernel', raw: true } })
      expect(response.result?.isError).not.toBe(true)
      const result = parsed<{ results: { id: string }[] }>(response)
      expect(result.results.length).toBeGreaterThan(0)
      expect(result.results[0]?.id).toBe('k1')
    })

    it('returns isError for invalid raw FTS5 syntax', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_memory_set', arguments: { key: 'k', value: 'content' } })
      const response = await mcp.call('tools/call', { name: 'db_memory_search', arguments: { query: "what's the plan?", raw: true } })
      expect(response.result?.isError).toBe(true)
    })
  })

  describe('bm25 sign and snippet', () => {
    it('returns positive scores (higher = better)', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_memory_set', arguments: { key: 'exact', value: 'rust kernel storage' } })
      await mcp.call('tools/call', { name: 'db_memory_set', arguments: { key: 'partial', value: 'rust is a systems language for kernels' } })
      const result = parsed<{ results: { id: string; score: number }[] }>(await mcp.call('tools/call', { name: 'db_memory_search', arguments: { query: 'rust kernel storage' } }))
      expect(result.results.length).toBeGreaterThan(0)
      for (const r of result.results) {
        expect(r.score).toBeGreaterThanOrEqual(0)
      }
    })

    it('doc excerpt is match-centered and contains the search term', async () => {
      const mcp = await readyServer()
      const padding = 'word '.repeat(500)
      const text = `${padding}unique_marker_xyz${' word'.repeat(500)}`
      await mcp.call('tools/call', { name: 'db_doc_save', arguments: { id: 'doc', text } })
      const result = parsed<{ results: { id: string; excerpt: string }[] }>(await mcp.call('tools/call', { name: 'db_doc_search', arguments: { query: 'unique_marker_xyz' } }))
      expect(result.results[0]?.id).toBe('doc')
      expect(result.results[0]?.excerpt).toContain('unique_marker_xyz')
      expect(result.results[0]?.excerpt.length).toBeLessThan(500)
    })

    it('event excerpt is match-centered', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_session_create', arguments: { id: 's1', name: 'Test' } })
      const padding = 'A'.repeat(500)
      await mcp.call('tools/call', { name: 'db_event_log', arguments: { session_id: 's1', event_type: 'note', content: `${padding} the special_marker_42 was found ${padding}` } })
      const result = parsed<{ results: { excerpt: string }[] }>(await mcp.call('tools/call', { name: 'db_event_search', arguments: { query: 'special_marker_42', session_id: 's1' } }))
      expect(result.results.length).toBeGreaterThan(0)
      expect(result.results[0]?.excerpt).toContain('special_marker_42')
    })
  })

  describe('status validation', () => {
    it('rejects invalid todo status on update', async () => {
      const mcp = await readyServer()
      const addResult = parsed<{ id: number }>(await mcp.call('tools/call', { name: 'db_todo_add', arguments: { title: 'Test' } }))
      const response = await mcp.call('tools/call', { name: 'db_todo_update', arguments: { id: addResult.id, status: 'done' } })
      expect(response.result?.isError).toBe(true)
    })

    it('rejects invalid session status on update', async () => {
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

  describe('tag join tables', () => {
    it('cache_index filters by tag', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_cache_store', arguments: { id: 'a', content: 'auth', topic: 'auth', summary: 'JWT', tags: ['security'] } })
      await mcp.call('tools/call', { name: 'db_cache_store', arguments: { id: 'b', content: 'db', topic: 'db', summary: 'Postgres', tags: ['database'] } })
      const result = parsed<{ table: string }>(await mcp.call('tools/call', { name: 'db_cache_index', arguments: { tag: 'security' } }))
      expect(result.table).toContain('a')
      expect(result.table).not.toContain('| b |')
    })

    it('todo_list filters by tag via join table', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_todo_add', arguments: { title: 'Task A', tags: ['frontend', 'urgent'] } })
      await mcp.call('tools/call', { name: 'db_todo_add', arguments: { title: 'Task B', tags: ['backend'] } })
      const result = parsed<{ results: { title: string }[] }>(await mcp.call('tools/call', { name: 'db_todo_list', arguments: { tag: 'urgent' } }))
      expect(result.results.length).toBe(1)
      expect(result.results[0]?.title).toBe('Task A')
    })

    it('context_by_tags uses join table', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_context_add', arguments: { entry_id: 'e1', title: 'A', content: 'a', tags: ['x', 'y'] } })
      await mcp.call('tools/call', { name: 'db_context_add', arguments: { entry_id: 'e2', title: 'B', content: 'b', tags: ['y', 'z'] } })
      await mcp.call('tools/call', { name: 'db_context_add', arguments: { entry_id: 'e3', title: 'C', content: 'c', tags: ['w'] } })
      const result = parsed<{ results: { entry_id: string }[] }>(await mcp.call('tools/call', { name: 'db_context_by_tags', arguments: { tags: ['x', 'z'] } }))
      const ids = result.results.map((r) => r.entry_id)
      expect(ids).toContain('e1')
      expect(ids).toContain('e2')
      expect(ids).not.toContain('e3')
    })

    it('updating cache replaces tags in join table', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_cache_store', arguments: { id: 'c', content: 'content', topic: 't', summary: 's', tags: ['old'] } })
      await mcp.call('tools/call', { name: 'db_cache_store', arguments: { id: 'c', content: 'content', topic: 't', summary: 's', tags: ['new'] } })
      const oldResult = parsed<{ table: string }>(await mcp.call('tools/call', { name: 'db_cache_index', arguments: { tag: 'old' } }))
      expect(oldResult.table).toContain('0 entries')
      const newResult = parsed<{ table: string }>(await mcp.call('tools/call', { name: 'db_cache_index', arguments: { tag: 'new' } }))
      expect(newResult.table).toContain('c')
    })
  })

  describe('update truthiness — empty string clearing', () => {
    it('todo_update can clear description with empty string', async () => {
      const mcp = await readyServer()
      const addResult = parsed<{ id: number }>(await mcp.call('tools/call', { name: 'db_todo_add', arguments: { title: 'Test', description: 'Original description' } }))
      await mcp.call('tools/call', { name: 'db_todo_update', arguments: { id: addResult.id, description: '' } })
      const list = parsed<{ results: { description: string }[] }>(await mcp.call('tools/call', { name: 'db_todo_list', arguments: {} }))
      expect(list.results[0]?.description).toBe('')
    })

    it('todo_update can clear title with empty string', async () => {
      const mcp = await readyServer()
      const addResult = parsed<{ id: number }>(await mcp.call('tools/call', { name: 'db_todo_add', arguments: { title: 'Original Title' } }))
      const response = await mcp.call('tools/call', { name: 'db_todo_update', arguments: { id: addResult.id, title: '' } })
      expect(response.result?.isError).not.toBe(true)
    })

    it('session_update can clear description with empty string', async () => {
      const mcp = await readyServer()
      await mcp.call('tools/call', { name: 'db_session_create', arguments: { id: 's1', name: 'Test', description: 'Original' } })
      await mcp.call('tools/call', { name: 'db_session_update', arguments: { id: 's1', description: '' } })
      const session = parsed<{ description: string }>(await mcp.call('tools/call', { name: 'db_session_get', arguments: { id: 's1' } }))
      expect(session.description).toBe('')
    })
  })
})
