import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, type ChildProcess } from 'node:child_process'

interface RpcResponse {
  id?: number
  result?: { content?: { text: string }[]; isError?: boolean }
  error?: unknown
}

class McpProcess {
  private readonly child: ChildProcess
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: RpcResponse) => void; reject: (error: Error) => void }>()
  private stderr = ''

  constructor(storageDir: string) {
    this.child = spawn('node', ['bin/whimsicality-db.js'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, WHIMSICALITY_DB_DIR: storageDir },
    })
    this.child.stdout?.on('data', (data: Buffer) => {
      this.buffer += data.toString()
      const lines = this.buffer.split('\n')
      this.buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line) as RpcResponse & { jsonrpc: string; method?: string }
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const handler = this.pending.get(msg.id)!
            this.pending.delete(msg.id)
            handler.resolve(msg)
          }
        } catch { }
      }
    })
    this.child.stderr?.on('data', (data: Buffer) => { this.stderr += data.toString() })
  }

  async call(method: string, params: unknown): Promise<RpcResponse> {
    const id = this.nextId++
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`no response. stderr: ${this.stderr}`))
      }, 5000)
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timeout); resolve(r) },
        reject: (e) => { clearTimeout(timeout); reject(e) },
      })
      this.child.stdin?.write(msg + '\n')
    })
  }

  async init(): Promise<void> {
    await this.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } })
  }

  stop(): void {
    this.child.kill()
  }

  async stopAndWait(): Promise<void> {
    if (this.child.killed || this.child.exitCode !== null) return
    this.child.kill()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { try { this.child.kill('SIGKILL') } catch { }; resolve() }, 3000)
      this.child.once('exit', () => { clearTimeout(timer); resolve() })
    })
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
  const servers: McpProcess[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'whim-db-test-'))
  })

  afterEach(async () => {
    for (const server of servers) await server.stopAndWait()
    servers.length = 0
    try { rmSync(dir, { recursive: true, force: true }) } catch { }
  })

  function server(): McpProcess {
    const proc = new McpProcess(dir)
    servers.push(proc)
    return proc
  }

  async function readyServer(): Promise<McpProcess> {
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
})
