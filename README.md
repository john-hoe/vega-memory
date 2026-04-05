# Vega Memory

Vega Memory is a local-first memory system for coding workflows. It stores durable project knowledge in SQLite, exposes it through a CLI, MCP server, HTTP API, and web dashboard, and uses Ollama for embeddings, extraction, and compression when available.

## Architecture

```text
                   +---------------------------+
                   |         Web UI            |
                   |   GET / dashboard + JS    |
                   +-------------+-------------+
                                 |
                                 v
+-------------+     +------------+-------------+     +----------------------+
| CLI         |     | HTTP API / MCP Server    |     | Scheduler / Daemon   |
| commander.js| --> | Express + MCP SDK tools  | <-- | backups, health,     |
| local ops   |     | store/recall/session     |     | compaction, alerts   |
+-------------+     +------------+-------------+     +----------------------+
                                 |
                                 v
                   +-------------+-------------+
                   |         Services          |
                   | memory, recall, session,  |
                   | docs, quality, insights,  |
                   | plugins, templates, team  |
                   +-------------+-------------+
                                 |
                                 v
                   +-------------+-------------+
                   |    Repository / SQLite    |
                   | memories, FTS5, metadata, |
                   | teams, sessions, audit    |
                   +-------------+-------------+
                                 |
               +-----------------+-----------------+
               |                                   |
               v                                   v
      +--------+--------+                 +--------+--------+
      | Ollama embed/chat|                | Filesystem      |
      | embeddings, AI   |                | backups, docs,  |
      | compression      |                | plugins, alerts |
      +------------------+                +-----------------+
```

## Quick Start

### Install and build

```bash
npm install
npx tsc
npm link
```

### Configure the server runtime

```bash
export VEGA_DB_PATH=./data/memory.db
export OLLAMA_BASE_URL=http://localhost:11434
export OLLAMA_MODEL=bge-m3
export VEGA_API_KEY=change-me
export VEGA_API_PORT=3271
```

### Start the scheduler, HTTP API, and dashboard

```bash
node dist/scheduler/index.js
```

With `VEGA_API_KEY` set, the scheduler starts the API and serves the dashboard at `http://127.0.0.1:3271/`.

### Run the CLI

```bash
vega health
vega store "Use better-sqlite3 for local persistence" --type decision --project vega
vega recall "better-sqlite3" --project vega
```

### Register the MCP server manually

Build first, then point your MCP client at `dist/index.js`. Example `~/.cursor/mcp.json` entry:

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

### Configure a remote client

```bash
vega setup --server 192.168.1.10 --port 3271 --api-key change-me
```

This writes `~/.vega/config.json` and updates `~/.cursor/mcp.json` for client mode.

## CLI Reference

### Bootstrap and security

| Command | Purpose | Example |
| --- | --- | --- |
| `vega setup --server <host> --port <port> --api-key <key>` | Configure a machine as a Vega client | `vega setup --server 192.168.1.10 --port 3271 --api-key change-me` |
| `vega init-encryption` | Generate and store an encryption key in the macOS Keychain | `vega init-encryption` |

### Core memory workflow

| Command | Purpose | Example |
| --- | --- | --- |
| `vega store <content> --type <type> --project <project>` | Store a memory | `vega store "Use WAL checkpoints before backup" --type pitfall --project vega` |
| `vega recall <query> [--project <project>] [--type <type>]` | Search relevant memories | `vega recall "WAL checkpoint" --project vega --limit 5` |
| `vega list [--project <project>] [--type <type>]` | List memories | `vega list --project vega --sort importance --limit 20` |
| `vega session-start [--dir <path>] [--hint <text>]` | Start a coding session and load context | `vega session-start --dir . --hint "dashboard auth flow"` |
| `vega session-end --project <project> --summary <text>` | End a session and extract durable memories | `vega session-end --project vega --summary "Decided to expose the dashboard at /"` |
| `vega health [--json]` | Show memory system health | `vega health --json` |

### Maintenance, export, and diagnostics

| Command | Purpose | Example |
| --- | --- | --- |
| `vega compact [--project <project>]` | Merge duplicates and archive stale memories | `vega compact --project vega` |
| `vega compress [--memory-id <id> \| --project <project>]` | Compress long memories with Ollama | `vega compress --project vega --min-length 1200` |
| `vega backup [--cloud]` | Create a local backup and optionally copy it to the configured cloud-sync directory | `vega backup --cloud` |
| `vega snapshot` | Export a markdown snapshot of active memories | `vega snapshot` |
| `vega stats` | Show counts by type, project, and status | `vega stats` |
| `vega export [--format json\|md]` | Export memories | `vega export --format json --project vega -o memories.json` |
| `vega import <file>` | Import memories from JSON or markdown | `vega import memories.json` |
| `vega migrate <file>` | Migrate `##` markdown sections into pitfall memories | `vega migrate notes.md` |
| `vega diagnose [--issue <text>]` | Write a diagnostic report | `vega diagnose --issue "slow recall performance"` |
| `vega audit [--actor <actor>] [--action <action>]` | Inspect audit history | `vega audit --action update --limit 50` |
| `vega benchmark [--suite all\|write\|recall\|concurrent] [--report]` | Run benchmark suites | `vega benchmark --suite recall --report` |
| `vega quality [--project <project>] [--degrade]` | Score memory quality and optionally lower low-quality importance | `vega quality --project vega --degrade --json` |

### Knowledge and indexing

| Command | Purpose | Example |
| --- | --- | --- |
| `vega graph <entity> [--depth <n>]` | Query the knowledge graph | `vega graph SQLite --depth 2` |
| `vega index <directory> [--ext ts,js,py]` | Index exported code symbols into memory | `vega index src --ext ts,tsx` |
| `vega index-docs <path> [--project <project>]` | Index markdown and text documents | `vega index-docs docs --project vega` |
| `vega generate-docs --project <project>` | Generate README, decision log, and pitfall guide from memories | `vega generate-docs --project vega --type all --output docs/generated` |
| `vega git-import <repo-path> [--since <date>]` | Import recent git subjects into memory | `vega git-import . --since "7 days ago"` |
| `vega screenshot <image-path> --description <text>` | Store a screenshot reference | `vega screenshot ./error.png --description "Auth error state" --project vega` |

### Platform and ecosystem

| Command | Purpose | Example |
| --- | --- | --- |
| `vega plugins` / `vega plugins list` | List plugin directories under `data/plugins/` that contain `plugin.json` | `vega plugins list` |
| `vega templates` / `vega templates list` | List starter memory templates | `vega templates list` |
| `vega templates install <name>` | Install starter template rules as global preference memories | `vega templates install frontend-dev` |

### Memory types

Supported memory types are:

- `task_state`
- `preference`
- `project_context`
- `decision`
- `pitfall`
- `insight`

## MCP Tools Reference

Vega’s MCP server is built with `@modelcontextprotocol/sdk` and exposes the following tools:

| Tool | Purpose | Parameters |
| --- | --- | --- |
| `memory_graph` | Query entity relations and connected memories | `entity`, `depth` |
| `memory_store` | Store a memory entry | `content`, `type`, `project?`, `title?`, `tags?`, `importance?`, `source?` |
| `memory_recall` | Recall relevant memories | `query`, `project?`, `type?`, `limit?`, `min_similarity?` |
| `memory_list` | List memories | `project?`, `type?`, `limit?`, `sort?` |
| `memory_update` | Update an existing memory | `id`, `title?`, `content?`, `importance?`, `tags?` |
| `memory_delete` | Delete a memory | `id` |
| `session_start` | Load session context | `working_directory`, `task_hint?` |
| `session_end` | Persist a session summary | `project`, `summary`, `completed_tasks?` |
| `memory_health` | Return current health information | none |
| `memory_diagnose` | Write and return a diagnostic report | `issue?` |
| `memory_compact` | Merge duplicates and archive stale memories | `project?` |
| `memory_compress` | Compress one memory or a batch | `memory_id?`, `project?`, `min_length?` |
| `memory_observe` | Forward external tool execution data into the passive observer | `tool_name`, `project?`, `input?`, `output?` |

Notes:

- `memory_compress` is available when the runtime includes the compression service.
- `memory_observe` is registered only when `VEGA_OBSERVER_ENABLED=true`.

## HTTP API Reference

The scheduler-hosted API exposes the dashboard and the JSON API.

| Route | Method | Purpose |
| --- | --- | --- |
| `/` | `GET` | Serve the web dashboard |
| `/api/store` | `POST` | Store a memory |
| `/api/recall` | `POST` | Search memories |
| `/api/list` | `GET` | List memories |
| `/api/memory/:id` | `PATCH` | Update a memory |
| `/api/memory/:id` | `DELETE` | Delete a memory |
| `/api/session/start` | `POST` | Start a session |
| `/api/session/end` | `POST` | End a session |
| `/api/health` | `GET` | Return health status |
| `/api/compact` | `POST` | Run compaction |

Detailed request and response examples live in [docs/API.md](/Users/johnmacmini/workspace/vega-memory/docs/API.md).

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `VEGA_DB_PATH` | `./data/memory.db` | Primary SQLite database path |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama base URL |
| `OLLAMA_MODEL` | `bge-m3` | Embedding and chat model name |
| `VEGA_TOKEN_BUDGET` | `2000` | Session token budget |
| `VEGA_SIMILARITY_THRESHOLD` | `0.85` | Similarity threshold used by memory dedupe |
| `VEGA_BACKUP_RETENTION_DAYS` | `7` | Local backup retention window |
| `VEGA_OBSERVER_ENABLED` | `false` | Enable passive observer storage |
| `VEGA_API_PORT` | `3271` | Scheduler HTTP API port |
| `VEGA_API_KEY` | unset | Bearer token required for `/api/*` |
| `VEGA_MODE` | `server` | Runtime mode: `server` or `client` |
| `VEGA_SERVER_URL` | unset | Remote server URL in client mode |
| `VEGA_CACHE_DB` | `~/.vega/cache.db` | Local cache database in client mode |
| `VEGA_TG_BOT_TOKEN` | unset | Telegram bot token for alerts |
| `VEGA_TG_CHAT_ID` | unset | Telegram chat target |
| `VEGA_ENCRYPTION_KEY` | unset | 64-character hex key for encrypted backups and exports |
| `VEGA_CLOUD_BACKUP_DIR` | unset | Enables local-sync cloud backups to a directory |
| `VEGA_SQLITE_VEC_PATH` | unset | Optional explicit path to the `sqlite-vec` extension |
| `SQLITE_VEC_PATH` | unset | Alternate `sqlite-vec` extension path |

## Development

### Build and test

```bash
npx tsc
npm test
```

Targeted test examples:

```bash
node --test dist/tests/platform.test.js
node --test dist/tests/api.test.js dist/tests/scheduler.test.js
```

### Add a plugin

Create a directory under `data/plugins/<plugin-name>/` with a `plugin.json` file:

```json
{
  "name": "example-plugin",
  "version": "0.1.0",
  "main": "index.js"
}
```

Example `index.js`:

```js
export default {
  name: "example-plugin",
  version: "0.1.0",
  init(context) {
    context.registerTool("example_tool", async (input) => {
      return { ok: true, input };
    });
  }
};
```

Current plugin support is foundation-only: Vega can discover and load plugins through `PluginLoader`, and the CLI can list directories that contain valid manifests.

### Install a starter template

```bash
vega templates install frontend-dev
```

This stores the template rules as global `preference` memories.

## License

MIT
