import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { openDatabase, defaultStorageDir } from './database.js'
import { Store, MAX_CONTENT_CHARS, MAX_TEXT_CHARS, MAX_IDENTIFIER_CHARS, MAX_TAGS, MAX_TAG_CHARS, DEFAULT_READ_LENGTH, DEFAULT_LIMIT, validateId, validateText, validateTags } from './store.js'

const VERSION = '0.1.0'

interface ToolDef {
  name: string
  description: string
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false }
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
}

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const DELETE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }

const str = (description: string, max = MAX_TEXT_CHARS): Record<string, unknown> => ({ type: 'string', minLength: 1, maxLength: max, description })
const optStr = (description: string, max: number): Record<string, unknown> => ({ type: 'string', maxLength: max, description })
const schema = (properties: Record<string, unknown>, required: string[] = []): ToolDef['inputSchema'] => ({ type: 'object', properties, required, additionalProperties: false })
const idProp = str('Identifier', MAX_IDENTIFIER_CHARS)
const topKProp = { type: 'integer', minimum: 1, maximum: 100, description: 'Max results (default: 10)' }
const limitProp = { type: 'integer', minimum: 1, maximum: 1000, description: `Max results (default: ${DEFAULT_LIMIT})` }
const offsetProp = { type: 'integer', minimum: 0, description: 'Character offset (default: 0)' }
const lengthProp = { type: 'integer', minimum: 1, maximum: MAX_CONTENT_CHARS, description: `Max chars to return (default: ${DEFAULT_READ_LENGTH})` }
const tagsProp = { type: 'array', items: { type: 'string', maxLength: MAX_TAG_CHARS }, maxItems: MAX_TAGS, description: 'Tags for filtering and search' }
const priorityProp = { type: 'integer', minimum: 0, maximum: 100, description: 'Priority (0=low, 100=high, default: 0)' }

const TOOLS: readonly ToolDef[] = [
  // Memory
  { name: 'db_memory_set', description: 'Store persistent text in a namespaced key-value memory. Use for facts, plans, decisions, or any text an agent should recall later.', inputSchema: schema({ key: str('Key within namespace', MAX_IDENTIFIER_CHARS), value: str('Text to store'), namespace: optStr('Namespace (default: "default")', MAX_IDENTIFIER_CHARS) }, ['key', 'value']), annotations: WRITE },
  { name: 'db_memory_get', description: 'Retrieve a stored memory value by key and namespace. Error if not found.', inputSchema: schema({ key: str('Key', MAX_IDENTIFIER_CHARS), namespace: optStr('Namespace (default: "default")', MAX_IDENTIFIER_CHARS) }, ['key']), annotations: RO },
  { name: 'db_memory_list', description: 'List all keys in a namespace.', inputSchema: schema({ namespace: optStr('Namespace (default: "default")', MAX_IDENTIFIER_CHARS) }), annotations: RO },
  { name: 'db_memory_delete', description: 'Delete a memory entry. Returns deleted:false if the key did not exist.', inputSchema: schema({ key: str('Key', MAX_IDENTIFIER_CHARS), namespace: optStr('Namespace (default: "default")', MAX_IDENTIFIER_CHARS) }, ['key']), annotations: DELETE },
  { name: 'db_memory_search', description: 'FTS5 full-text search across all memory values. Returns ranked matches with BM25 scores.', inputSchema: schema({ query: str('Search query', 10_000), topK: topKProp }, ['query']), annotations: RO },

  // Docs
  { name: 'db_doc_save', description: 'Save a document for FTS5 full-text search. Use for long-form text, code, or reference material.', inputSchema: schema({ id: idProp, text: str('Document text'), language: optStr('Language or format tag', MAX_IDENTIFIER_CHARS), description: optStr('Short description', 10_000) }, ['id', 'text']), annotations: WRITE },
  { name: 'db_doc_get', description: 'Retrieve a full document by ID. Error if not found.', inputSchema: schema({ id: idProp }, ['id']), annotations: RO },
  { name: 'db_doc_search', description: 'FTS5 search over documents. Returns match-centered excerpts with BM25 scores.', inputSchema: schema({ query: str('Search query', 10_000), topK: topKProp }, ['query']), annotations: RO },
  { name: 'db_doc_list', description: 'List saved document IDs.', inputSchema: schema({}), annotations: RO },
  { name: 'db_doc_delete', description: 'Delete a document. Returns deleted:false if the id did not exist.', inputSchema: schema({ id: idProp }, ['id']), annotations: DELETE },

  // Cache (compressed paged content)
  { name: 'db_cache_store', description: 'Store large content in the compressed paged cache. Brotli-compressed on disk. Returns compression stats. Read it back in pages via db_cache_read.', inputSchema: schema({ id: idProp, content: str('Content to cache (will be compressed)', MAX_CONTENT_CHARS), topic: optStr('Short topic label (auto-generated if omitted)', 80), summary: optStr('One-line summary for index (auto-generated if omitted)', 200), tags: tagsProp }, ['id', 'content']), annotations: WRITE },
  { name: 'db_cache_read', description: 'Read cached content by ID with paging (offset + length). Returns content, offset, length, total_length, and has_more.', inputSchema: schema({ id: idProp, offset: offsetProp, length: lengthProp }, ['id']), annotations: RO },
  { name: 'db_cache_index', description: 'Get a compact summary table of cached content. Token cost printed at bottom. Use to discover what is available before reading.', inputSchema: schema({ topic: optStr('Optional topic filter', 80), limit: limitProp }), annotations: RO },
  { name: 'db_cache_search', description: 'FTS5 search over cache index (topic, summary, tags). Returns ranked summaries.', inputSchema: schema({ query: str('Search query', 10_000), topK: topKProp }, ['query']), annotations: RO },
  { name: 'db_cache_list', description: 'List all cached chunk IDs.', inputSchema: schema({}), annotations: RO },
  { name: 'db_cache_delete', description: 'Delete a cached chunk. Returns deleted:false if the id did not exist.', inputSchema: schema({ id: idProp }, ['id']), annotations: DELETE },
  { name: 'db_cache_stats', description: 'Return cache statistics: entry count, total bytes, compression ratio.', inputSchema: schema({}), annotations: RO },

  // Todos
  { name: 'db_todo_add', description: 'Add a todo item with optional priority, tags, and session linkage. Returns the todo ID.', inputSchema: schema({ title: str('Todo title', 10_000), description: optStr('Detailed description', MAX_TEXT_CHARS), priority: priorityProp, tags: tagsProp, session_id: optStr('Link to a session', MAX_IDENTIFIER_CHARS) }, ['title']), annotations: WRITE },
  { name: 'db_todo_list', description: 'List todos, optionally filtered by status, tag, or session. Ordered by priority (desc) then created_at (asc).', inputSchema: schema({ status: optStr('Filter by status: pending, in_progress, completed', 20), tag: optStr('Filter by tag', MAX_TAG_CHARS), session_id: optStr('Filter by session', MAX_IDENTIFIER_CHARS), limit: limitProp }), annotations: RO },
  { name: 'db_todo_update', description: 'Update a todo item. Any field can be updated; omitted fields are preserved. Use status=completed to mark done.', inputSchema: schema({ id: { type: 'integer', description: 'Todo ID' }, status: optStr('New status: pending, in_progress, completed', 20), title: optStr('New title', 10_000), description: optStr('New description', MAX_TEXT_CHARS), priority: priorityProp }, ['id']), annotations: WRITE },
  { name: 'db_todo_delete', description: 'Delete a todo item. Returns deleted:false if the id did not exist.', inputSchema: schema({ id: { type: 'integer', description: 'Todo ID' } }, ['id']), annotations: DELETE },
  { name: 'db_todo_search', description: 'FTS5 search over todo titles and descriptions. Returns ranked matches.', inputSchema: schema({ query: str('Search query', 10_000), topK: topKProp }, ['query']), annotations: RO },

  // Context index (tagged entries)
  { name: 'db_context_add', description: 'Add a tagged context entry. Use for reference material, decisions, architecture notes, or any content the model should pull by tag when needed.', inputSchema: schema({ entry_id: idProp, title: str('Entry title', 10_000), content: str('Entry content', MAX_CONTENT_CHARS), tags: tagsProp, source: optStr('Where this came from (file, URL, etc.)', 256) }, ['entry_id', 'title', 'content']), annotations: WRITE },
  { name: 'db_context_get', description: 'Retrieve a context entry by ID. Returns full content.', inputSchema: schema({ entry_id: idProp }, ['entry_id']), annotations: RO },
  { name: 'db_context_by_tags', description: 'Retrieve context entries by tag. Returns entries matching ANY of the specified tags, ordered by most recently updated.', inputSchema: schema({ tags: { type: 'array', items: { type: 'string' }, description: 'Tags to search for' }, limit: limitProp }, ['tags']), annotations: RO },
  { name: 'db_context_search', description: 'FTS5 search over context entries (title, content, tags). Returns ranked matches.', inputSchema: schema({ query: str('Search query', 10_000), topK: topKProp }, ['query']), annotations: RO },
  { name: 'db_context_delete', description: 'Delete a context entry. Returns deleted:false if the id did not exist.', inputSchema: schema({ entry_id: idProp }, ['entry_id']), annotations: DELETE },

  // Sessions
  { name: 'db_session_create', description: 'Create or update a session for tracking a long-horizon task. Sessions group events and todos.', inputSchema: schema({ id: idProp, name: str('Session name', 10_000), description: optStr('What this session is about', MAX_TEXT_CHARS) }, ['id', 'name']), annotations: WRITE },
  { name: 'db_session_get', description: 'Get session details by ID.', inputSchema: schema({ id: idProp }, ['id']), annotations: RO },
  { name: 'db_session_list', description: 'List sessions, optionally filtered by status.', inputSchema: schema({ status: optStr('Filter by status: active, paused, completed, abandoned', 20), limit: limitProp }), annotations: RO },
  { name: 'db_session_update', description: 'Update a session. Use status=completed/abandoned/paused to change lifecycle.', inputSchema: schema({ id: idProp, status: optStr('New status', 20), name: optStr('New name', 10_000), description: optStr('New description', MAX_TEXT_CHARS) }, ['id']), annotations: WRITE },

  // Events
  { name: 'db_event_log', description: 'Log an event within a session. Use for decisions, milestones, errors, observations, or notes. Events are FTS5-searchable.', inputSchema: schema({ session_id: optStr('Session ID (optional for standalone events)', MAX_IDENTIFIER_CHARS), event_type: str('Event type: decision, milestone, error, note, observation', 256), content: str('Event content', MAX_TEXT_CHARS), metadata: optStr('JSON metadata', MAX_TEXT_CHARS) }, ['event_type', 'content']), annotations: WRITE },
  { name: 'db_event_list', description: 'List events, optionally filtered by session and/or event type. Ordered newest first.', inputSchema: schema({ session_id: optStr('Filter by session', MAX_IDENTIFIER_CHARS), event_type: optStr('Filter by type: decision, milestone, error, note, observation', 256), limit: limitProp }), annotations: RO },
  { name: 'db_event_search', description: 'FTS5 search over event content. Returns ranked matches with excerpts.', inputSchema: schema({ query: str('Search query', 10_000), session_id: optStr('Filter to a specific session', MAX_IDENTIFIER_CHARS), topK: topKProp }, ['query']), annotations: RO },

  // Stats
  { name: 'db_stats', description: 'Return database statistics: counts for each table and total database size in bytes.', inputSchema: schema({}), annotations: RO },
]

function dispatch(store: Store, name: string, args: Record<string, unknown>): unknown {
  const id = (n: string): string => validateId(String(args[n] ?? ''), n)
  const text = (n: string, max?: number): string => validateText(String(args[n] ?? ''), n, max)
  const optText = (n: string): string => (args[n] === undefined || args[n] === null || (typeof args[n] === 'string' && (args[n] as string).length === 0) ? '' : String(args[n]))
  const topK = (): number => { const v = args.topK ?? 10; if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 100) throw new Error('topK must be an integer from 1 to 100'); return v as number }
  const limit = (): number => { const v = args.limit ?? DEFAULT_LIMIT; if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 1000) throw new Error('limit must be an integer from 1 to 1000'); return v as number }
  const offset = (): number => { const v = args.offset ?? 0; if (!Number.isInteger(v) || (v as number) < 0) throw new Error('offset must be a non-negative integer'); return v as number }
  const length = (): number => { const v = args.length ?? DEFAULT_READ_LENGTH; if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > MAX_CONTENT_CHARS) throw new Error(`length must be an integer from 1 to ${MAX_CONTENT_CHARS}`); return v as number }
  const tags = (): string[] => validateTags(args.tags)
  const ns = (): string => optText('namespace') || 'default'
  const intArg = (n: string): number | null => { const v = args[n]; if (v === undefined || v === null) return null; if (!Number.isInteger(v)) throw new Error(`Argument "${n}" must be an integer`); return v as number }

  switch (name) {
    // Memory
    case 'db_memory_set': return store.memorySet(ns(), id('key'), text('value'))
    case 'db_memory_get': return store.memoryGet(ns(), id('key'))
    case 'db_memory_list': return store.memoryList(ns())
    case 'db_memory_delete': return store.memoryDelete(ns(), id('key'))
    case 'db_memory_search': return { results: store.memorySearch(text('query', 10_000), topK()) }
    // Docs
    case 'db_doc_save': return store.docSave(id('id'), text('text'), optText('language'), optText('description'))
    case 'db_doc_get': return store.docGet(id('id'))
    case 'db_doc_search': return { results: store.docSearch(text('query', 10_000), topK()) }
    case 'db_doc_list': return store.docList()
    case 'db_doc_delete': return store.docDelete(id('id'))
    // Cache
    case 'db_cache_store': {
      const topic = optText('topic')
      const summary = optText('summary')
      return store.cacheStore(id('id'), text('content', MAX_CONTENT_CHARS), topic, summary, tags())
    }
    case 'db_cache_read': return store.cacheRead(id('id'), offset(), length())
    case 'db_cache_index': return { table: store.cacheIndex(args.topic ? String(args.topic) : null, limit()) }
    case 'db_cache_search': return { results: store.cacheSearch(text('query', 10_000), topK()) }
    case 'db_cache_list': return store.cacheList()
    case 'db_cache_delete': return store.cacheDelete(id('id'))
    case 'db_cache_stats': return store.cacheStats()
    // Todos
    case 'db_todo_add': return store.todoAdd(text('title', 10_000), optText('description'), intArg('priority') ?? 0, tags(), optText('session_id') || null)
    case 'db_todo_list': return { results: store.todoList(optText('status') || null, optText('tag') || null, optText('session_id') || null, limit()) }
    case 'db_todo_update': return store.todoUpdate(intArg('id') as number, optText('status') || null, optText('title') || null, args.description !== undefined ? String(args.description) : null, intArg('priority'))
    case 'db_todo_delete': return store.todoDelete(intArg('id') as number)
    case 'db_todo_search': return { results: store.todoSearch(text('query', 10_000), topK()) }
    // Context
    case 'db_context_add': return store.contextAdd(id('entry_id'), text('title', 10_000), text('content', MAX_CONTENT_CHARS), tags(), optText('source'))
    case 'db_context_get': return store.contextGet(id('entry_id'))
    case 'db_context_by_tags': return { results: store.contextByTags(tags(), limit()) }
    case 'db_context_search': return { results: store.contextSearch(text('query', 10_000), topK()) }
    case 'db_context_delete': return store.contextDelete(id('entry_id'))
    // Sessions
    case 'db_session_create': return store.sessionCreate(id('id'), text('name', 10_000), optText('description'))
    case 'db_session_get': return store.sessionGet(id('id'))
    case 'db_session_list': return { results: store.sessionList(optText('status') || null, limit()) }
    case 'db_session_update': return store.sessionUpdate(id('id'), optText('status') || null, optText('name') || null, args.description !== undefined ? String(args.description) : null)
    // Events
    case 'db_event_log': return store.eventLog(optText('session_id') || null, text('event_type', 256), text('content', MAX_TEXT_CHARS), optText('metadata') || '{}')
    case 'db_event_list': return { results: store.eventList(optText('session_id') || null, optText('event_type') || null, limit()) }
    case 'db_event_search': return { results: store.eventSearch(text('query', 10_000), optText('session_id') || null, topK()) }
    // Stats
    case 'db_stats': return store.stats()
    default: throw new Error(`Unknown tool: ${name}`)
  }
}

function getStorageDir(): string {
  const envDir = process.env.WHIMSICALITY_DB_DIR
  if (envDir && envDir.length > 0) return envDir
  return defaultStorageDir()
}

async function main(): Promise<void> {
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
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (error) {
      return {
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      }
    }
  })
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((error) => {
  process.stderr.write(`whimsicality-db: fatal error\n${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
