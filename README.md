# Vega Memory System

Vega Memory System is a local MCP memory server for AI coding sessions. It stores durable engineering context in SQLite, exposes that context through a CLI, MCP tools, an HTTP API, and a lightweight web dashboard, and can use Ollama for embeddings, recall, summarization, and compression.

## Architecture

```text
                           +---------------------------+
                           |    Cursor / MCP Client    |
                           |  stdio -> dist/index.js   |
                           +-------------+-------------+
                                         |
                                         v
+-------------+     +--------------------+--------------------+     +----------------------+
| CLI         |     | Vega Memory Runtime                      |     | Scheduler / Daemon   |
| commander.js| --> | MCP tools + HTTP API + dashboard mount  | <-- | health, backup,      |
| local ops   |     | Express routes, auth, session services  |     | compaction, alerts   |
+-------------+     +--------------------+--------------------+     +----------------------+
                                         |
                                         v
                           +-------------+-------------+
                           | Core Services             |
                           | memory, recall, session,  |
                           | compression, graph, docs, |
                           | plugins, templates, team  |
                           +-------------+-------------+
                                         |
                                         v
                           +-------------+-------------+
                           | SQLite Repository         |
                           | better-sqlite3, FTS,      |
                           | metadata, sessions, teams |
                           +-------------+-------------+
                                         |
                   +---------------------+----------------------+
                   |                                            |
                   v                                            v
          +--------+--------+                         +---------+---------+
          | Ollama           |                        | Local filesystem   |
          | embeddings/chat  |                        | backups, reports,  |
          | localhost:11434  |                        | plugins, exports   |
          +------------------+                        +-------------------+
```

## Quick Start

### 1. Install and build

```bash
npm install
npm run build
npm link
```

### 2. Configure the runtime

```bash
export VEGA_DB_PATH=./data/memory.db
export OLLAMA_BASE_URL=http://localhost:11434
export OLLAMA_MODEL=bge-m3
export VEGA_API_KEY=change-me
export VEGA_API_PORT=3271
```

### 3. Start the scheduler, HTTP API, and dashboard

```bash
node dist/scheduler/index.js
```

With `VEGA_API_KEY` set, Vega exposes the authenticated HTTP API under `/api/*` and serves the dashboard at `http://127.0.0.1:3271/`.

### 4. Use the CLI

```bash
vega health
vega store "Use better-sqlite3 for local persistence" --type decision --project vega
vega recall "better-sqlite3" --project vega
```

### 5. Register the MCP server in Cursor

Add Vega to `~/.cursor/mcp.json` after building:

```json
{
  "mcpServers": {
    "vega": {
      "command": "node",
      "args": ["/absolute/path/to/vega-memory/dist/index.js"],
      "env": {
        "VEGA_DB_PATH": "./data/memory.db",
        "OLLAMA_BASE_URL": "http://localhost:11434",
        "OLLAMA_MODEL": "bge-m3"
      }
    }
  }
}
```

### 6. Configure a remote client machine

```bash
vega setup --server 192.168.1.10 --port 3271 --api-key change-me
```

That writes `~/.vega/config.json` and updates `~/.cursor/mcp.json` for client mode.

## CLI Commands

### Core workflow

| Command | Purpose | Example |
| --- | --- | --- |
| `vega store <content> --type <type> --project <project>` | Store a memory | `vega store "Checkpoint WAL before backup" --type pitfall --project vega` |
| `vega recall <query> [--project <project>] [--type <type>]` | Recall relevant memories | `vega recall "sqlite backup" --project vega --limit 5` |
| `vega list [--project <project>] [--type <type>]` | List stored memories | `vega list --project vega --sort "updated_at DESC" --limit 20` |
| `vega session-start [--dir <path>] [--hint <text>]` | Load context for the current coding session | `vega session-start --dir . --hint "dashboard auth flow"` |
| `vega session-end --project <project> --summary <text>` | End a session and extract durable memories | `vega session-end --project vega --summary "Mounted dashboard at /"` |
| `vega health [--json]` | Report memory system health | `vega health --json` |

### Maintenance and diagnostics

| Command | Purpose | Example |
| --- | --- | --- |
| `vega compact [--project <project>]` | Merge duplicates and archive stale memories | `vega compact --project vega` |
| `vega diagnose [--issue <text>]` | Generate a diagnostic report | `vega diagnose --issue "recall latency spike"` |
| `vega migrate <file>` | Convert markdown notes into memories | `vega migrate notes.md` |
| `vega export [--format json\|md]` | Export memories | `vega export --format json --project vega -o memories.json` |
| `vega import <file>` | Import memories from JSON or markdown | `vega import memories.json` |
| `vega benchmark [--suite all\|write\|recall\|concurrent]` | Run benchmark suites | `vega benchmark --suite recall --report` |
| `vega compress [--memory-id <id> \| --project <project>]` | Compress long memories with Ollama | `vega compress --project vega --min-length 1200` |
| `vega quality [--project <project>]` | Score memory quality | `vega quality --project vega --degrade --json` |

### Knowledge and indexing

| Command | Purpose | Example |
| --- | --- | --- |
| `vega generate-docs --project <project>` | Generate project docs from stored memory | `vega generate-docs --project vega --type all --output docs/generated` |
| `vega graph <entity> [--depth <n>]` | Query the knowledge graph | `vega graph SQLite --depth 2` |
| `vega index <directory> [--ext ts,tsx,js]` | Index source code into memory | `vega index src --ext ts,tsx` |
| `vega index-docs <path> [--project <project>]` | Index markdown and text docs | `vega index-docs docs --project vega` |
| `vega git-import <repo-path> [--since <date>]` | Import recent git history into memory | `vega git-import . --since "7 days ago"` |
| `vega screenshot <image-path> --description <text>` | Store a screenshot reference | `vega screenshot ./error.png --description "Auth error state" --project vega` |

### Platform and bootstrap

| Command | Purpose | Example |
| --- | --- | --- |
| `vega setup --server <host> --port <port> --api-key <key>` | Configure a remote client and Cursor MCP entry | `vega setup --server 192.168.1.10 --port 3271 --api-key change-me` |
| `vega init-encryption` | Generate and store an encryption key in macOS Keychain | `vega init-encryption` |
| `vega plugins` / `vega plugins list` | List plugin directories that contain `plugin.json` | `vega plugins list` |
| `vega templates` / `vega templates list` | List built-in starter templates | `vega templates list` |
| `vega templates install <name>` | Install starter template rules as `preference` memories | `vega templates install frontend-dev` |

### Additional commands

| Command | Purpose |
| --- | --- |
| `vega backup [--cloud]` | Create an encrypted or plain backup |
| `vega snapshot` | Export a markdown snapshot of active memories |
| `vega stats` | Show aggregate counts by type, project, and status |
| `vega audit` | Inspect audit history |

### Memory types

Supported memory types:

- `task_state`
- `preference`
- `project_context`
- `decision`
- `pitfall`
- `insight`

## MCP Tools

Vega uses `@modelcontextprotocol/sdk` and exposes these MCP tools:

| Tool | Purpose | Parameters |
| --- | --- | --- |
| `memory_store` | Store a memory entry | `content`, `type`, `project?`, `title?`, `tags?`, `importance?`, `source?` |
| `memory_recall` | Recall relevant memories | `query`, `project?`, `type?`, `limit?`, `min_similarity?` |
| `memory_list` | List memories | `project?`, `type?`, `limit?`, `sort?` |
| `memory_update` | Update a memory | `id`, `title?`, `content?`, `importance?`, `tags?` |
| `memory_delete` | Delete a memory | `id` |
| `session_start` | Load context for a working directory | `working_directory`, `task_hint?` |
| `session_end` | End a session and persist extracted memories | `project`, `summary`, `completed_tasks?` |
| `memory_health` | Return the current health report | none |
| `memory_compact` | Merge duplicates and archive stale items | `project?` |
| `memory_diagnose` | Generate a diagnostic report | `issue?` |
| `memory_graph` | Query related entities and linked memories | `entity`, `depth` |
| `memory_compress` | Compress one memory or a batch | `memory_id?`, `project?`, `min_length?` |
| `memory_observe` | Forward external tool data into Vega's observer | `tool_name`, `project?`, `input?`, `output?` |

Notes:

- `memory_compress` is registered when the compression service is available.
- `memory_observe` is registered only when `VEGA_OBSERVER_ENABLED=true`.

## HTTP API

When the scheduler runs with `VEGA_API_KEY` configured, it serves the dashboard at `/` and the JSON API under `/api/*`.

| Route | Method | Purpose |
| --- | --- | --- |
| `/` | `GET` | Serve the dashboard |
| `/api/store` | `POST` | Store a memory |
| `/api/recall` | `POST` | Recall memories |
| `/api/list` | `GET` | List memories |
| `/api/memory/:id` | `PATCH` | Update a memory |
| `/api/memory/:id` | `DELETE` | Delete a memory |
| `/api/session/start` | `POST` | Start a session |
| `/api/session/end` | `POST` | End a session |
| `/api/health` | `GET` | Read health status |
| `/api/compact` | `POST` | Run compaction |

Detailed request and response examples are in [`docs/API.md`](docs/API.md).

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `VEGA_DB_PATH` | `./data/memory.db` | SQLite database path |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama API base URL |
| `OLLAMA_MODEL` | `bge-m3` | Ollama embedding and chat model |
| `VEGA_TOKEN_BUDGET` | `2000` | Session token budget |
| `VEGA_SIMILARITY_THRESHOLD` | `0.85` | Similarity threshold for memory dedupe |
| `VEGA_BACKUP_RETENTION_DAYS` | `7` | Local backup retention window |
| `VEGA_OBSERVER_ENABLED` | `false` | Enable passive tool observation |
| `VEGA_API_PORT` | `3271` | HTTP API port |
| `VEGA_API_KEY` | unset | Bearer token required for `/api/*` |
| `VEGA_MODE` | `server` | Runtime mode: `server` or `client` |
| `VEGA_SERVER_URL` | unset | Remote Vega server URL in client mode |
| `VEGA_CACHE_DB` | `~/.vega/cache.db` | Local cache DB for client mode |
| `VEGA_TG_BOT_TOKEN` | unset | Telegram bot token for alerts |
| `VEGA_TG_CHAT_ID` | unset | Telegram chat target for alerts |
| `VEGA_ENCRYPTION_KEY` | unset | Hex encryption key for backups and exports |
| `VEGA_CLOUD_BACKUP_DIR` | unset | Directory for local-sync cloud backup copies |
| `VEGA_SQLITE_VEC_PATH` | unset | Preferred path to the `sqlite-vec` extension |
| `SQLITE_VEC_PATH` | unset | Alternate path to the `sqlite-vec` extension |

## Development

### Build and test

```bash
npm run build
npm test
```

### Plugin foundation

Plugins are discovered from `data/plugins/<plugin-name>/plugin.json`. A minimal plugin manifest looks like this:

```json
{
  "name": "example-plugin",
  "version": "0.1.0",
  "main": "index.js"
}
```

Starter templates are available through `vega templates list`, and plugin discovery is available through `vega plugins list`.

## License

MIT
