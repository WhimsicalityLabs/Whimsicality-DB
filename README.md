# whimsicality-db

A SQLite-backed MCP server with FTS5 full-text search for truly infinite agent context. Session tracking, event logging, todo management, and tagged context index for long-horizon tasks and heavy workloads.

## Quick start

Add to your MCP client config:

```json
{
  "mcpServers": {
    "whimsicality-db": {
      "command": "npx",
      "args": ["whimsicality-db"]
    }
  }
}
```

Data is stored at `~/.whimsicality/db-storage/whimsicality.db` by default (SQLite with WAL mode). Set `WHIMSICALITY_DB_DIR` to override.

## Why SQLite?

The companion server [`whimsicality-mcp`](https://github.com/WhimsicalityLabs/Whimsicality-MCP) uses a JSON file for memory and docs. It's simple and correct, but every write rewrites the whole file and every search re-tokenizes the whole corpus. Fine for hundreds of entries, unusable for tens of thousands.

This server uses SQLite with FTS5:

| Problem | JSON file | SQLite + FTS5 |
|---------|-----------|---------------|
| Write cost | O(n) full rewrite | O(log n) B-tree insert |
| Search cost | O(n) re-tokenize per query | O(log n) inverted index lookup |
| BM25 | Hand-rolled, recomputed | Native FTS5 bm25() function |
| Concurrency | Lockfile + atomic rename | WAL mode: concurrent readers + 1 writer |
| Durability | fsync + rename | SQLite WAL + journal |
| Scale wall | ~1,000 entries | ~1,000,000+ entries |

## What's different from whimsicality-mcp

Three new collections that the JSON server doesn't have:

### Todos

Task tracking with status (pending/in_progress/completed), priority, tags, and session linkage. The model can add tasks, update their status, search them, and filter by tag or session. Useful for long-horizon work where the model needs to track its own progress across context window boundaries.

### Context index

Tagged content entries that the model pulls by tag when needed. Instead of loading everything into context, the model stores reference material, architecture decisions, and domain knowledge with tags, then retrieves only what's relevant via `db_context_by_tags(["security", "auth"])`. This is the "multiple files with tags" pattern — the model has a dense catalog of tagged knowledge and pulls only what it needs.

### Sessions + Events

Session tracking for long-horizon tasks. Create a session, log events (decisions, milestones, errors, observations) as they happen, and search them later. When a task spans multiple context windows, the session log is the persistent memory that connects them — the model can search past decisions and events without re-deriving them.

## Tools (32 total)

### Memory — namespaced key-value store (5)

| Tool | Description |
|---|---|
| `db_memory_set` | Store persistent text. Namespaced key-value. |
| `db_memory_get` | Retrieve by key and namespace. Error if not found. |
| `db_memory_list` | List all keys in a namespace. |
| `db_memory_delete` | Delete an entry. Returns deleted:false if absent. |
| `db_memory_search` | FTS5 search across all memory values with BM25 ranking. |

### Documents — full-text searchable (5)

| Tool | Description |
|---|---|
| `db_doc_save` | Save a document for FTS5 search. |
| `db_doc_get` | Retrieve a full document by ID. |
| `db_doc_search` | FTS5 search. Returns match-centered excerpts. |
| `db_doc_list` | List saved document IDs. |
| `db_doc_delete` | Delete a document. |

### Cache — compressed paged content (7)

| Tool | Description |
|---|---|
| `db_cache_store` | Store content. Brotli-compressed. Returns compression stats. |
| `db_cache_read` | Read by ID with paging (offset + length). Returns total_length + has_more. |
| `db_cache_index` | Compact summary table with token estimate. |
| `db_cache_search` | FTS5 search over cache metadata (topic, summary, tags). |
| `db_cache_list` | List all cached chunk IDs. |
| `db_cache_delete` | Delete a cached chunk. |
| `db_cache_stats` | Entry count, total bytes, compression ratio. |

### Todos — task tracking (5)

| Tool | Description |
|---|---|
| `db_todo_add` | Add a todo with priority, tags, and optional session linkage. |
| `db_todo_list` | List todos, filter by status/tag/session. Ordered by priority desc. |
| `db_todo_update` | Update status, title, description, or priority. |
| `db_todo_delete` | Delete a todo. |
| `db_todo_search` | FTS5 search over todo titles and descriptions. |

### Context index — tagged content retrieval (5)

| Tool | Description |
|---|---|
| `db_context_add` | Add a tagged context entry (reference material, decisions, notes). |
| `db_context_get` | Retrieve a context entry by ID. |
| `db_context_by_tags` | Retrieve entries matching ANY of the specified tags. |
| `db_context_search` | FTS5 search over context entries (title, content, tags). |
| `db_context_delete` | Delete a context entry. |

### Sessions — long-horizon task tracking (4)

| Tool | Description |
|---|---|
| `db_session_create` | Create or update a session. |
| `db_session_get` | Get session details by ID. |
| `db_session_list` | List sessions, optionally filtered by status. |
| `db_session_update` | Update session status (active/paused/completed/abandoned). |

### Events — session log (3)

| Tool | Description |
|---|---|
| `db_event_log` | Log an event (decision, milestone, error, note, observation). |
| `db_event_list` | List events, filter by session and/or type. |
| `db_event_search` | FTS5 search over event content. |

### Stats (1)

| Tool | Description |
|---|---|
| `db_stats` | Database statistics: counts per table + total DB size. |

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│ SQLite Database (WAL mode)                               │
│                                                          │
│  memory       ─── memory_fts (FTS5)                     │
│  docs         ─── docs_fts   (FTS5)                     │
│  cache        ─── cache_fts  (FTS5)                     │
│  todos        ─── todos_fts  (FTS5)                     │
│  context_entries ── context_fts (FTS5)                  │
│  sessions     (no FTS — small, direct query)            │
│  events       ─── events_fts (FTS5)                     │
│                                                          │
│  Triggers keep FTS5 indexes in sync automatically.      │
│  WAL mode allows concurrent readers + 1 writer.         │
└──────────────────────────────────────────────────────────┘
```

Every table with text content has a corresponding FTS5 virtual table with triggers that keep the index in sync on insert/update/delete. Searches use SQLite's native `bm25()` function for ranking — no re-tokenization, no recomputation.

The cache table stores content as brotli-compressed BLOBs. `db_cache_read` decompresses on demand with offset+length paging.

## When to use which collection

- **Memory**: small key-value pairs you want to recall by exact key (facts, decisions, config)
- **Docs**: documents you want to search by content (returns matching excerpts)
- **Cache**: large content you want to page in on demand (compressed, paged reads)
- **Todos**: tasks the model is tracking across context windows (status, priority, tags)
- **Context index**: reference material the model pulls by tag when needed (architecture, domain knowledge, patterns)
- **Sessions**: long-horizon task containers (group events and todos)
- **Events**: chronological log within a session (decisions, milestones, errors)

## Configuration

| Variable | Default | Description |
|---|---|---|
| `WHIMSICALITY_DB_DIR` | `~/.whimsicality/db-storage` | Database storage directory |

## Development

```bash
git clone https://github.com/WhimsicalityLabs/Whimsicality-DB.git
cd Whimsicality-DB
npm install
npm test
npm run typecheck
```

The test suite covers all 32 tools: memory CRUD + search, docs CRUD + search, cache compression + paging + search, todos CRUD + filtering + search, context index add/get/by-tags/search, sessions + events, cross-process visibility, and input validation.

## License

MIT
