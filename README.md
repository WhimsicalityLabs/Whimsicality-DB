# whimsicality-db

A work journal for long-running agents. SQLite-backed MCP server with session tracking, event logging, and FTS5 search — so agents working across multiple context windows can recall decisions, search past events, and track their own progress.

## Why this exists

Agents doing long-horizon work have a problem: when the context window fills up, they lose track of what they decided, what they tried, and what's left to do. The conversation history scrolls off, and the agent re-derives conclusions it already reached.

`whimsicality-db` solves this with a persistent work journal:

1. **Create a session** for the task: `db_session_create({ id: "refactor-auth", name: "Refactor auth system" })`
2. **Log events as they happen**: `db_event_log({ session_id: "refactor-auth", event_type: "decision", content: "Chose JWT over session cookies for stateless auth" })`
3. **Search past decisions**: `db_search({ query: "auth decision", collections: ["events"] })`
4. **Track todos across context windows**: `db_todo_add({ title: "Implement JWT verification", session_id: "refactor-auth" })`

When the agent comes back after a context window reset, it searches the session log and picks up where it left off — without re-reading the entire conversation.

## Quick start

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

Data is stored at `~/.whimsicality/db-storage/whimsicality.db` (SQLite, WAL mode). Set `WHIMSICALITY_DB_DIR` to override.

## Migrating from whimsicality-mcp

If you used the deprecated `whimsicality-mcp` package, import your data:

```
db_import({ source_dir: "~/.whimsicality/mcp-storage" })
```

Imports memory entries, documents, and compressed cache chunks into the unified entries table.

## Tools (21 total, ~2,700 tokens of schema)

### Memory — key-value facts (4)

| Tool | Description |
|---|---|
| `db_memory_set` | Store a key-value fact. Namespaced. |
| `db_memory_get` | Recall a value by key. |
| `db_memory_list` | List keys in a namespace. |
| `db_memory_delete` | Delete a memory key. |

### Entries — unified text store with auto-compression (5)

Replaces the old docs, cache, and context collections. Small text is stored as-is and FTS5-indexed. Large text (>64KB) is auto-compressed with brotli and paged on read. Tags and source are optional.

| Tool | Description |
|---|---|
| `db_entry_save` | Store text. Auto-compresses if large. Tags and source optional. |
| `db_entry_read` | Read entry by ID. Supports paging via offset+length. |
| `db_entry_list` | List entries. Optional tag filter. |
| `db_entry_by_tags` | Get entries matching any of the given tags. |
| `db_entry_delete` | Delete an entry. |

### Todos — task tracking across context windows (4)

| Tool | Description |
|---|---|
| `db_todo_add` | Add a todo with priority, tags, session link. |
| `db_todo_list` | List todos. Filter by status/tag/session. |
| `db_todo_update` | Update a todo. Empty string clears a field. |
| `db_todo_delete` | Delete a todo. |

### Sessions — long-horizon task containers (3)

| Tool | Description |
|---|---|
| `db_session_create` | Create or update a session for long-horizon tasks. |
| `db_session_list` | List sessions. Optional status filter. Pass id to get one. |
| `db_session_update` | Update session. Empty string clears name/description. |

### Events — session log (2)

| Tool | Description |
|---|---|
| `db_event_log` | Log an event in a session. FTS5-searchable. |
| `db_event_list` | List events. Filter by session/type. |

### Search + stats + import (3)

| Tool | Description |
|---|---|
| `db_search` | Unified FTS5 search across collections. Returns ranked results with BM25 scores. |
| `db_stats` | Database statistics: counts and size. |
| `db_import` | Import data from whimsicality-mcp storage directory. |

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│ SQLite Database (WAL mode)                               │
│                                                          │
│  memory       ─── memory_fts (FTS5)                     │
│  entries      ─── entries_fts (FTS5)                    │
│    ├─ small:  content_text (plain, FTS5-indexed)        │
│    └─ large:  content (brotli BLOB) + title (FTS5)      │
│  entry_tags   ── normalized tag join table               │
│  todos        ─── todos_fts  (FTS5)                     │
│  todo_tags    ── normalized tag join table               │
│  sessions     (no FTS — small, direct query)            │
│  events       ─── events_fts (FTS5)                     │
│                                                          │
│  Triggers keep FTS5 indexes in sync automatically.      │
│  WAL mode: concurrent readers + 1 writer.               │
│  CHECK constraints on status columns.                   │
│  Schema version migrations (v1→v2→v3).                  │
└──────────────────────────────────────────────────────────┘
```

### Unified search

`db_search({ query, collections, top_k })` searches across memory, entries, todos, and events in one call. Results are merged and ranked by BM25 score (higher = better). Each result includes its collection, ID, score, and a match-centered excerpt where applicable.

### Auto-compression

Entries above 64KB are automatically brotli-compressed. The title/summary is stored as plain text for FTS5 indexing. `db_entry_read` decompresses on demand with offset+length paging.

### Native module note

This package depends on `better-sqlite3`, a native Node.js addon. `npm install` usually finds prebuilt binaries automatically. If not, `node-gyp` compiles from source — you'll need Python 3 and a C++ compiler. Node 22.5+ ships `node:sqlite` with FTS5 built in, which is a future zero-dependency path.

### Schema migrations

The `schema_version` table tracks the database schema version. On open, the server reads the version and applies migrations sequentially: v1→v2 (tag join tables), v2→v3 (unified entries table merging docs/cache/context).

## When to use which collection

- **Memory**: small key-value pairs you want to recall by exact key (facts, config)
- **Entries**: any text content — documents, references, large content. Auto-compresses, tags optional, paged reads
- **Todos**: tasks the model is tracking across context windows
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
```

67 tests: 64 in-process (store, search, entries, todos, sessions, events, validation, import) + 3 bin smoke (spawns the actual `bin/whimsicality-db.js` entry point).

## License

MIT
