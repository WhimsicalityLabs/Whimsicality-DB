import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { openDatabase, defaultStorageDir } from './database.js'
import { Store, MAX_CONTENT_CHARS, MAX_TEXT_CHARS, MAX_IDENTIFIER_CHARS, MAX_TAGS, MAX_TAG_CHARS, DEFAULT_READ_LENGTH, DEFAULT_LIMIT, validateId, validateText, validateTags } from './store.js'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const VERSION = require('../package.json').version as string

interface ToolDef {
  name: string
  description: string
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false }
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
}

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const DELETE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }

const s = (d: string, max = MAX_TEXT_CHARS): Record<string, unknown> => ({ type: 'string', minLength: 1, maxLength: max, description: d })
const os = (d: string, max: number): Record<string, unknown> => ({ type: 'string', maxLength: max, description: d })
const schema = (p: Record<string, unknown>, r: string[] = []): ToolDef['inputSchema'] => ({ type: 'object', properties: p, required: r, additionalProperties: false })
const idP = s('ID', MAX_IDENTIFIER_CHARS)
const topKP = { type: 'integer', minimum: 1, maximum: 100, description: 'Max results (default 10)' }
const limitP = { type: 'integer', minimum: 1, maximum: 1000, description: `Max results (default ${DEFAULT_LIMIT})` }
const offsetP = { type: 'integer', minimum: 0, description: 'Char offset (default 0)' }
const lengthP = { type: 'integer', minimum: 1, maximum: MAX_CONTENT_CHARS, description: `Max chars (default ${DEFAULT_READ_LENGTH})` }
const tagsP = { type: 'array', items: { type: 'string', maxLength: MAX_TAG_CHARS }, maxItems: MAX_TAGS, description: 'Tags' }
const tagP = { type: 'string', maxLength: MAX_TAG_CHARS, description: 'Filter by tag' }
const priorityP = { type: 'integer', minimum: 0, maximum: 100, description: 'Priority 0-100 (default 0)' }
const rawP = { type: 'boolean', default: false, description: 'Raw FTS5 syntax (AND, OR, NOT, *)' }
const sidP = os('Session ID', MAX_IDENTIFIER_CHARS)
const typeP = s('Type: decision|milestone|error|note', 256)
const collectionsP = { type: 'array', items: { type: 'string', enum: ['memory', 'entries', 'todos', 'events'] }, description: 'Collections to search (default: all)' }

const TOOLS: readonly ToolDef[] = [
  { name: 'db_memory_set', description: 'Store a key-value fact. Namespaced.', inputSchema: schema({ key: s('Key', MAX_IDENTIFIER_CHARS), value: s('Value'), namespace: os('Namespace (default "default")', MAX_IDENTIFIER_CHARS) }, ['key', 'value']), annotations: WRITE },
  { name: 'db_memory_get', description: 'Recall a value by key.', inputSchema: schema({ key: s('Key', MAX_IDENTIFIER_CHARS), namespace: os('Namespace', MAX_IDENTIFIER_CHARS) }, ['key']), annotations: RO },
  { name: 'db_memory_list', description: 'List keys in a namespace.', inputSchema: schema({ namespace: os('Namespace (default "default")', MAX_IDENTIFIER_CHARS) }), annotations: RO },
  { name: 'db_memory_delete', description: 'Delete a memory key.', inputSchema: schema({ key: s('Key', MAX_IDENTIFIER_CHARS), namespace: os('Namespace', MAX_IDENTIFIER_CHARS) }, ['key']), annotations: DELETE },

  { name: 'db_entry_save', description: 'Store text. Auto-compresses >64KB. Tags/source optional.', inputSchema: schema({ id: idP, text: s('Text content', MAX_CONTENT_CHARS), title: os('Title/summary', 200), tags: tagsP, source: os('Source (file, URL)', 256), compress: { type: 'boolean', description: 'Force compression' } }, ['id', 'text']), annotations: WRITE },
  { name: 'db_entry_read', description: 'Read entry by ID. Supports paging.', inputSchema: schema({ id: idP, offset: offsetP, length: lengthP }, ['id']), annotations: RO },
  { name: 'db_entry_list', description: 'List entries. Optional tag filter.', inputSchema: schema({ tag: tagP, limit: limitP }), annotations: RO },
  { name: 'db_entry_by_tags', description: 'Get entries matching any tag.', inputSchema: schema({ tags: { type: 'array', items: { type: 'string' }, description: 'Tags to match' }, limit: limitP }, ['tags']), annotations: RO },
  { name: 'db_entry_delete', description: 'Delete an entry.', inputSchema: schema({ id: idP }, ['id']), annotations: DELETE },

  { name: 'db_todo_add', description: 'Add a todo with priority, tags, session link.', inputSchema: schema({ title: s('Title', 10_000), description: os('Description', MAX_TEXT_CHARS), priority: priorityP, tags: tagsP, sid: sidP }, ['title']), annotations: WRITE },
  { name: 'db_todo_list', description: 'List todos. Filter by status/tag/session.', inputSchema: schema({ status: os('pending|in_progress|completed', 20), tag: tagP, sid: sidP, limit: limitP }), annotations: RO },
  { name: 'db_todo_update', description: 'Update a todo. Empty string clears a field.', inputSchema: schema({ id: { type: 'integer', description: 'Todo ID' }, status: os('pending|in_progress|completed', 20), title: os('New title', 10_000), description: os('New description', MAX_TEXT_CHARS), priority: priorityP }, ['id']), annotations: WRITE },
  { name: 'db_todo_delete', description: 'Delete a todo.', inputSchema: schema({ id: { type: 'integer', description: 'Todo ID' } }, ['id']), annotations: DELETE },

  { name: 'db_session_create', description: 'Create or update a session.', inputSchema: schema({ id: idP, name: s('Session name', 10_000), description: os('Description', MAX_TEXT_CHARS) }, ['id', 'name']), annotations: WRITE },
  { name: 'db_session_list', description: 'List sessions. Optional status filter. Pass id to get one.', inputSchema: schema({ id: os('Session ID to get', MAX_IDENTIFIER_CHARS), status: os('active|paused|completed|abandoned', 20), limit: limitP }), annotations: RO },
  { name: 'db_session_update', description: 'Update session. Empty string clears name/description.', inputSchema: schema({ id: idP, status: os('active|paused|completed|abandoned', 20), name: os('New name', 10_000), description: os('New description', MAX_TEXT_CHARS) }, ['id']), annotations: WRITE },

  { name: 'db_event_log', description: 'Log an event in a session. FTS5-searchable.', inputSchema: schema({ sid: sidP, type: typeP, content: s('Event content', MAX_TEXT_CHARS), metadata: os('JSON metadata', MAX_TEXT_CHARS) }, ['type', 'content']), annotations: WRITE },
  { name: 'db_event_list', description: 'List events. Filter by session/type.', inputSchema: schema({ sid: sidP, type: os('Type filter', 256), limit: limitP }), annotations: RO },

  { name: 'db_search', description: 'Unified FTS5 search. BM25 ranked (higher=better).', inputSchema: schema({ query: s('Search query', 10_000), collections: collectionsP, k: topKP, raw: rawP }, ['query']), annotations: RO },
  { name: 'db_stats', description: 'Database statistics: counts and size.', inputSchema: schema({}), annotations: RO },
  { name: 'db_import', description: 'Import from whimsicality-mcp storage dir.', inputSchema: schema({ path: s('Path to whimsicality-mcp storage dir', 1024) }, ['path']), annotations: WRITE },
]

export function dispatch(store: Store, name: string, args: Record<string, unknown>): unknown {
  const id = (n: string): string => validateId(String(args[n] ?? ''), n)
  const text = (n: string, max?: number): string => validateText(String(args[n] ?? ''), n, max)
  const os = (n: string): string => (args[n] === undefined || args[n] === null ? '' : String(args[n]))
  const optNullable = (n: string): string | null => (args[n] === undefined || args[n] === null ? null : String(args[n]))
  const topK = (): number => { const v = args.k ?? 10; if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 100) throw new Error('k must be 1-100'); return v as number }
  const limit = (): number => { const v = args.limit ?? DEFAULT_LIMIT; if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 1000) throw new Error('limit must be 1-1000'); return v as number }
  const offset = (): number => { const v = args.offset ?? 0; if (!Number.isInteger(v) || (v as number) < 0) throw new Error('offset must be >= 0'); return v as number }
  const length = (): number => { const v = args.length ?? DEFAULT_READ_LENGTH; if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > MAX_CONTENT_CHARS) throw new Error(`length must be 1-${MAX_CONTENT_CHARS}`); return v as number }
  const tags = (): string[] => validateTags(args.tags)
  const ns = (): string => os('namespace') || 'default'
  const intArg = (n: string): number | null => { const v = args[n]; if (v === undefined || v === null) return null; if (!Number.isInteger(v)) throw new Error(`"${n}" must be integer`); return v as number }
  const raw = (): boolean => args.raw === true
  const collections = (): string[] => { const v = args.collections; if (!Array.isArray(v) || v.length === 0) return ['memory', 'entries', 'todos', 'events']; return v as string[] }

  switch (name) {
    case 'db_memory_set': return store.memorySet(ns(), id('key'), text('value'))
    case 'db_memory_get': return store.memoryGet(ns(), id('key'))
    case 'db_memory_list': return store.memoryList(ns())
    case 'db_memory_delete': return store.memoryDelete(ns(), id('key'))
    case 'db_entry_save': return store.entrySave(id('id'), text('text', MAX_CONTENT_CHARS), os('title'), tags(), os('source'), args.compress === undefined ? null : args.compress === true)
    case 'db_entry_read': return store.entryRead(id('id'), offset(), length())
    case 'db_entry_list': return store.entryList(optNullable('tag'), limit())
    case 'db_entry_by_tags': return { results: store.entryByTags(tags(), limit()) }
    case 'db_entry_delete': return store.entryDelete(id('id'))
    case 'db_todo_add': return store.todoAdd(text('title', 10_000), os('description'), intArg('priority') ?? 0, tags(), optNullable('sid'))
    case 'db_todo_list': return { results: store.todoList(optNullable('status'), optNullable('tag'), optNullable('sid'), limit()) }
    case 'db_todo_update': return store.todoUpdate(intArg('id') as number, optNullable('status'), optNullable('title'), optNullable('description'), intArg('priority'))
    case 'db_todo_delete': return store.todoDelete(intArg('id') as number)
    case 'db_session_create': return store.sessionCreate(id('id'), text('name', 10_000), os('description'))
    case 'db_session_list': {
      const sessionId = optNullable('id')
      if (sessionId) return store.sessionGet(sessionId)
      return { results: store.sessionList(optNullable('status'), limit()) }
    }
    case 'db_session_update': return store.sessionUpdate(id('id'), optNullable('status'), optNullable('name'), optNullable('description'))
    case 'db_event_log': return store.eventLog(optNullable('sid'), text('type', 256), text('content', MAX_TEXT_CHARS), os('metadata') || '{}')
    case 'db_event_list': return { results: store.eventList(optNullable('sid'), optNullable('type'), limit()) }
    case 'db_search': return { results: store.search(text('query', 10_000), collections(), topK(), raw()) }
    case 'db_stats': return store.stats()
    case 'db_import': return store.importMcp(String(args.path ?? ''))
    default: throw new Error(`Unknown tool: ${name}`)
  }
}

function getStorageDir(): string {
  const envDir = process.env.WHIMSICALITY_DB_DIR
  if (envDir && envDir.length > 0) return envDir
  return defaultStorageDir()
}

export async function main(): Promise<void> {
  const storageDir = getStorageDir()
  const db = openDatabase(storageDir)
  const store = new Store(db)
  const server = new Server(
    { name: 'whimsicality-db', version: VERSION },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    })) as Tool[],
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    try {
      const result = dispatch(store, name, args ?? {})
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    } catch (error) {
      return {
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      }
    }
  })
  const transport = new StdioServerTransport()
  await server.connect(transport)
  const shutdown = (): void => {
    try { db.pragma('wal_checkpoint(TRUNCATE)') } catch { }
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
