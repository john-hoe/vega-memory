# Vega Memory System

A local-first memory server that gives AI coding tools **persistent, cross-session memory**. Connect Cursor, Claude Code, Codex, OpenClaw, or any MCP-compatible client — they all share the same knowledge base, so nothing learned in one session is lost in the next.

### What it does

- **Remembers** decisions, pitfalls, preferences, and project context across sessions
- **Recalls** relevant experience via hybrid semantic search (Vector + BM25) when you start a new task
- **Deduplicates** automatically — storing the same lesson twice merges instead of duplicating
- **Warns proactively** — "last time you worked on FFmpeg, 62% of issues were path-related"
- **Works offline** — SQLite + local Ollama, zero cloud dependency, zero API cost

### Supported AI tools

| Tool | Interface | How it connects |
|------|-----------|----------------|
| **Cursor** | MCP (stdio) | Registered in `~/.cursor/mcp.json` — Agent auto-calls memory tools |
| **Claude Code** | CLI | Rules in `CLAUDE.md` — runs `vega recall/store` via shell |
| **Codex CLI** | CLI | Rules in `AGENTS.md` — same CLI pattern |
| **OpenClaw** | HTTP API | Agent calls `/api/recall`, `/api/store` via HTTP |
| **Any MCP client** | MCP (stdio) | Same config as Cursor — works with any MCP-compatible tool |
| **Scripts / CI** | CLI or HTTP | `vega recall --json` or `curl /api/recall` |

### Before vs After

| | Without Vega | With Vega |
|---|---|---|
| New session context | Starts from zero, or loads entire `AGENTS.md` (~4000 tokens) | Loads only relevant memories (~500 tokens) |
| Cross-session knowledge | Lost when conversation ends | Persisted in SQLite, searchable forever |
| Multi-tool consistency | Each tool has its own silo | Cursor, Claude Code, Codex share the same memory |
| Bug fixed twice | "Didn't we solve this before?" | `session_start` surfaces the previous pitfall |
| Remote machines | Copy-paste context manually | Auto-sync via Tailscale, offline cache |

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
                           | SQLite (WAL mode)         |
                           | better-sqlite3, FTS5,     |
                           | hybrid search, versions   |
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

**Three interfaces, one memory:**

| Interface | Transport | Best For |
|-----------|-----------|----------|
| **MCP** | stdio | Cursor (auto-called by Agent) |
| **CLI** | shell | Claude Code, Codex, scripts, any terminal |
| **HTTP API** | REST | Remote machines, custom integrations, web dashboard |

---

## Prerequisites

- **Node.js** 18+
- **Ollama** running locally with the `bge-m3` model pulled (`ollama pull bge-m3`)

Ollama is optional — Vega degrades gracefully to keyword search (FTS5) when Ollama is unavailable.

---

## Quick Start

### 1. Clone and build

```bash
git clone https://github.com/your-username/vega-memory.git
cd vega-memory
npm install
npm run build
npm link   # makes the `vega` command available globally
```

### 2. Configure

Copy the example environment file and fill in your values:

```bash
cp .env.example .env
```

**`.env.example`:**
```bash
VEGA_DB_PATH=./data/memory.db
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=bge-m3
VEGA_API_KEY=              # REQUIRED for HTTP API — generate a strong random key
VEGA_API_PORT=3271
VEGA_TG_BOT_TOKEN=         # Optional: Telegram bot token for alerts
VEGA_TG_CHAT_ID=           # Optional: Telegram chat ID for alerts
```

> **Security:** Never commit `.env` to git. Generate a strong API key: `openssl rand -hex 16`

### 3. Verify

```bash
vega health
```

You should see a health report. If Ollama is running, `ollama: true`.

### 4. Store your first memory

```bash
vega store "Always use WAL mode for SQLite concurrent access" \
  --type decision --project my-project
```

### 5. Recall it

```bash
vega recall "sqlite concurrency" --project my-project
```

### 6. Connect your AI tools

| Tool | Interface | Setup |
|------|-----------|-------|
| **Cursor** | MCP (auto) | Add to `~/.cursor/mcp.json` → [Cursor setup](#cursor-mcp--recommended) |
| **Claude Code** | CLI | Add rules to `CLAUDE.md` → [Claude Code setup](#claude-code-cli) |
| **Codex CLI** | CLI | Add rules to `AGENTS.md` → [Codex setup](#codex-cli-cli) |
| **OpenClaw / Custom** | HTTP API | Call `/api/*` endpoints → [HTTP API setup](#openclaw--custom-agents-http-api) |
| **Any MCP client** | MCP (stdio) | Same config as Cursor |
| **Scripts / CI** | CLI or HTTP | `vega recall --json` or `curl /api/recall` |

Details for each tool are in the [Connecting AI Tools](#connecting-ai-tools) section below.

---

## Deployment

### Option A: Local Single Machine (Recommended Start)

Everything runs on one machine. The MCP server is spawned by Cursor per session; the scheduler daemon runs in the background for backups, compaction, and the HTTP API.

```bash
# Start the background scheduler (includes HTTP API + dashboard)
export VEGA_API_KEY=$(openssl rand -hex 16)
node dist/scheduler/index.js &

# Dashboard is at http://127.0.0.1:3271
# Log in with the same API key
```

**Auto-start on macOS** via launchd:

```bash
# Create the plist (adjust paths)
cat > ~/Library/LaunchAgents/dev.vega-memory.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://plist.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.vega-memory</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/vega-memory/dist/scheduler/index.js</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>VEGA_DB_PATH</key><string>/path/to/vega-memory/data/memory.db</string>
    <key>OLLAMA_BASE_URL</key><string>http://localhost:11434</string>
    <key>OLLAMA_MODEL</key><string>bge-m3</string>
    <key>VEGA_API_KEY</key><string>YOUR_GENERATED_KEY</string>
    <key>VEGA_API_PORT</key><string>3271</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/path/to/vega-memory/data/logs/scheduler-stdout.log</string>
  <key>StandardErrorPath</key><string>/path/to/vega-memory/data/logs/scheduler-stderr.log</string>
</dict>
</plist>
EOF

# Load it
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.vega-memory.plist
```

### Option B: Server + Remote Clients (Tailscale)

Run Vega on a central server (e.g., always-on Mac mini or VPS). Remote machines connect via the HTTP API over [Tailscale](https://tailscale.com) — a zero-config WireGuard mesh VPN.

#### Step 1: Install Tailscale on all machines

```bash
# macOS
brew install tailscale
# or download from https://tailscale.com/download

# Linux
curl -fsSL https://tailscale.com/install.sh | sh

# Windows
# Download from https://tailscale.com/download/windows
```

Log in on each machine:

```bash
sudo tailscale up
```

All machines on the same Tailscale account are now on a private encrypted network (`100.x.x.x`).

#### Step 2: Find your server's Tailscale IP

On the server (the machine running Vega):

```bash
tailscale ip -4
# Output: 100.x.x.x  (this is your Tailscale IP)
```

#### Step 3: Start Vega on the server

```bash
# Build and configure (see Quick Start above)
export VEGA_API_KEY=$(openssl rand -hex 16)
echo "Save this key: $VEGA_API_KEY"

node dist/scheduler/index.js
# API is now accessible at http://100.x.x.x:3271 from any Tailscale device
```

#### Step 4: Connect remote machines

On each remote machine (must be on the same Tailscale network):

```bash
npm install -g vega-memory   # or clone and npm link

vega setup --server 100.x.x.x --port 3271 --api-key YOUR_API_KEY
```

This command:
1. Creates `~/.vega/config.json` with the server connection
2. Registers Vega in `~/.cursor/mcp.json` in client mode
3. Sets up a local SQLite cache for offline resilience

#### Step 5: Verify

```bash
# On the remote machine
vega health
# Should show: status: "healthy", connected to the server

vega recall "test" --json
# Should return results from the server's memory database
```

#### Offline mode

When the remote machine loses connection to the server (e.g., no internet), Vega automatically falls back to its local cache:

- **Reads** are served from the cached copy
- **Writes** are queued in `~/.vega/pending/`
- **Reconnect** triggers automatic sync — pending writes are sent through the normal dedup pipeline

#### Tailscale ACLs (optional hardening)

For extra security, restrict which devices can access Vega's port in your [Tailscale ACL policy](https://login.tailscale.com/admin/acls):

```json
{
  "acls": [
    {
      "action": "accept",
      "src": ["group:engineering"],
      "dst": ["tag:vega-server:3271"]
    }
  ]
}
```

> **Security:** Tailscale provides WireGuard encryption for all traffic. The Vega API port (3271) is only reachable within your Tailscale network — it is never exposed to the public internet. The API key adds a second layer of authentication on top of the network-level security.

---

## Connecting AI Tools

### Cursor (MCP — Recommended)

Vega registers as an MCP server that Cursor calls automatically.

**1. Add to `~/.cursor/mcp.json`:**

```json
{
  "mcpServers": {
    "vega": {
      "command": "node",
      "args": ["/absolute/path/to/vega-memory/dist/index.js"],
      "env": {
        "VEGA_DB_PATH": "/absolute/path/to/vega-memory/data/memory.db",
        "OLLAMA_BASE_URL": "http://localhost:11434",
        "OLLAMA_MODEL": "bge-m3"
      }
    }
  }
}
```

**2. Add the Cursor rule** `.cursor/rules/memory.mdc` in your workspace:

```markdown
---
globs: ["**/*"]
alwaysApply: true
---

## Memory System Rules

### Normal Mode (MCP available)
- Session start → call vega.session_start(working_directory, task_hint)
- Task completed → call vega.memory_store(type: "task_state")
- Decision made → call vega.memory_store(type: "decision")
- Bug fixed → call vega.memory_store(type: "pitfall")
- New preference → call vega.memory_store(type: "preference")
- User says "remember" → call vega.memory_store(source: "explicit")
- Session ending → call vega.session_end(summary)
- Before storing → verify content is NOT: emotional complaints, failed debug attempts, one-time queries, raw data, common knowledge

### Fallback Mode (MCP unavailable)
- Session start → read data/snapshots/memory-snapshot.md
- New memories → append to data/snapshots/pending-memories.jsonl

### Alert Check
- Session start → check data/alerts/active-alert.md → if exists, read and inform user
```

**3. Restart Cursor.** The Agent will now auto-call `session_start` at the beginning of each conversation and store memories as you work.

---

### Claude Code (CLI)

Claude Code uses the `vega` CLI through shell commands. Add this to your project's `CLAUDE.md`:

```markdown
# Vega Memory Rules

## Session start
Run: `vega session-start --dir $(pwd) --json`
Parse the JSON output and use it as context for this session.

## Auto-store (do these automatically when appropriate)
- Task completed: `vega store "what was done" --type task_state --project PROJECT_NAME`
- Bug fixed: `vega store "error + solution" --type pitfall --project PROJECT_NAME`
- Decision made: `vega store "decision + reasoning" --type decision --project PROJECT_NAME`
- User says "remember": `vega store "content" --type preference --source explicit`

## Before making changes, search memory
Run: `vega recall "relevant query" --project PROJECT_NAME --json`

## Session end
Run: `vega session-end --project PROJECT_NAME --summary "what was accomplished"`
```

---

### Codex CLI (CLI)

Same pattern as Claude Code. Add to `AGENTS.md` in your project:

```markdown
# Vega Memory Rules

- Read the task instruction FIRST before doing anything
- On start: run `vega session-start --dir $(pwd) --json`, use output as context
- On task complete: `vega store "..." --type task_state --project PROJECT_NAME`
- On error solved: `vega store "..." --type pitfall --project PROJECT_NAME`
- On session end: `vega session-end --project PROJECT_NAME --summary "..."`
- Before changes, search: `vega recall "query" --project PROJECT_NAME --json`
```

---

### HTTP API (Any Tool / Custom Integration)

Any tool that can make HTTP requests can use Vega. Authentication is via Bearer token.

```bash
# Store a memory
curl -X POST http://YOUR_SERVER:3271/api/store \
  -H "Authorization: Bearer $VEGA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Always checkpoint WAL before backup",
    "type": "pitfall",
    "project": "my-project"
  }'

# Recall memories
curl -X POST http://YOUR_SERVER:3271/api/recall \
  -H "Authorization: Bearer $VEGA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "sqlite backup", "project": "my-project", "limit": 5}'

# Start a session
curl -X POST http://YOUR_SERVER:3271/api/session/start \
  -H "Authorization: Bearer $VEGA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"working_directory": "/path/to/project"}'

# Health check
curl -H "Authorization: Bearer $VEGA_API_KEY" \
  http://YOUR_SERVER:3271/api/health
```

For complete API documentation, see [`docs/API.md`](docs/API.md).

---

### OpenClaw / Custom Agents (HTTP API)

For OpenClaw agents or any custom AI agent, configure the agent to call the HTTP API. Example agent rules:

```markdown
# Vega Memory Connection
Server: http://YOUR_SERVER:3271
Auth: Bearer token (set via environment variable, never hardcode)

## When to store
- User shares a lesson learned → POST /api/store with type="pitfall"
- Technical decision made → POST /api/store with type="decision"
- User says "remember" → POST /api/store with source="explicit"

## When to recall
- Before answering technical questions → POST /api/recall
- At session start → POST /api/session/start
```

> **Important:** Always pass the API key via environment variable. Never hardcode credentials in agent configuration files.

---

## CLI Reference

### Core Workflow

| Command | Purpose |
|---------|---------|
| `vega store <content> --type <type> --project <p>` | Store a memory |
| `vega recall <query> [--project <p>] [--type <t>] [--json]` | Semantic search |
| `vega list [--project <p>] [--type <t>] [--sort <s>]` | List memories |
| `vega session-start [--dir <path>] [--hint <text>]` | Load session context |
| `vega session-end --project <p> --summary <text>` | End session, extract memories |
| `vega health [--json]` | System health report |

### Maintenance

| Command | Purpose |
|---------|---------|
| `vega compact [--project <p>]` | Merge duplicates, archive stale |
| `vega diagnose [--issue <text>]` | Generate diagnostic report |
| `vega backup [--cloud]` | Create backup |
| `vega export [--format json\|md] [-o file]` | Export memories |
| `vega import <file>` | Import from JSON or Markdown |
| `vega compress [--project <p>] [--min-length 1200]` | Compress long memories via Ollama |
| `vega quality [--project <p>]` | Score memory quality |
| `vega benchmark [--suite all\|write\|recall]` | Performance benchmarks |

### Knowledge & Indexing

| Command | Purpose |
|---------|---------|
| `vega graph <entity> [--depth <n>]` | Query knowledge graph |
| `vega index <dir> [--ext ts,tsx,js]` | Index source code |
| `vega index-docs <path> [--project <p>]` | Index markdown docs |
| `vega git-import <repo> [--since <date>]` | Import git history |
| `vega generate-docs --project <p>` | Generate docs from memory |

### Setup & Admin

| Command | Purpose |
|---------|---------|
| `vega setup --server <host> --port <port> --api-key <key>` | Configure remote client |
| `vega init-encryption` | Generate encryption key in macOS Keychain |
| `vega stats` | Aggregate counts by type/project/status |
| `vega audit [--actor <a>] [--action <a>]` | View audit log |
| `vega snapshot` | Export markdown snapshot |
| `vega plugins list` | List installed plugins |
| `vega templates list` / `vega templates install <name>` | Starter templates |

All commands support `--json` for machine-readable output.

### Memory Types

| Type | Purpose | Decay |
|------|---------|-------|
| `preference` | User preferences, coding style | Never |
| `project_context` | Architecture, stack, structure | Very slow |
| `task_state` | Current task progress | Fast (completed → archived) |
| `pitfall` | Bugs, errors, solutions | Never |
| `decision` | Technical decisions with reasoning | Moderate |
| `insight` | Auto-generated patterns (system only) | N/A |

---

## MCP Tools

| Tool | Purpose | Key Parameters |
|------|---------|---------------|
| `memory_store` | Store a memory | `content`, `type`, `project?`, `title?`, `tags?` |
| `memory_recall` | Semantic search | `query`, `project?`, `type?`, `limit?` |
| `memory_list` | Browse memories | `project?`, `type?`, `limit?`, `sort?` |
| `memory_update` | Update a memory | `id`, `content?`, `importance?`, `tags?` |
| `memory_delete` | Delete a memory | `id` |
| `session_start` | Load session context | `working_directory`, `task_hint?` |
| `session_end` | End session | `project`, `summary`, `completed_tasks?` |
| `memory_health` | Health report | — |
| `memory_compact` | Merge & archive | `project?` |
| `memory_diagnose` | Diagnostics | `issue?` |
| `memory_graph` | Knowledge graph query | `entity`, `depth` |
| `memory_compress` | Compress via Ollama | `memory_id?`, `project?`, `min_length?` |
| `memory_observe` | Passive tool observation | `tool_name`, `project?`, `input?`, `output?` |

---

## HTTP API

The scheduler serves an authenticated REST API when `VEGA_API_KEY` is configured.

| Route | Method | Purpose |
|-------|--------|---------|
| `/` | `GET` | Web dashboard (login required) |
| `/dashboard/login` | `POST` | Exchange API key for session cookie |
| `/dashboard/logout` | `POST` | Clear session |
| `/api/store` | `POST` | Store a memory |
| `/api/recall` | `POST` | Recall memories |
| `/api/list` | `GET` | List memories |
| `/api/memory/:id` | `PATCH` | Update a memory |
| `/api/memory/:id` | `DELETE` | Delete a memory |
| `/api/session/start` | `POST` | Start session |
| `/api/session/end` | `POST` | End session |
| `/api/health` | `GET` | Health status |
| `/api/compact` | `POST` | Run compaction |

Authentication: `Authorization: Bearer <your-api-key>` or dashboard session cookie.

See [`docs/API.md`](docs/API.md) for complete request/response examples.

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `VEGA_DB_PATH` | `./data/memory.db` | SQLite database path |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama API base URL |
| `OLLAMA_MODEL` | `bge-m3` | Embedding model name |
| `VEGA_API_KEY` | — | **Required** for HTTP API. Generate with `openssl rand -hex 16` |
| `VEGA_API_PORT` | `3271` | HTTP API port |
| `VEGA_TOKEN_BUDGET` | `2000` | Max tokens injected at session start |
| `VEGA_SIMILARITY_THRESHOLD` | `0.85` | Dedup similarity threshold |
| `VEGA_BACKUP_RETENTION_DAYS` | `7` | Days to keep backups |
| `VEGA_MODE` | `server` | `server` (primary) or `client` (remote) |
| `VEGA_SERVER_URL` | — | Remote Vega server URL (client mode) |
| `VEGA_CACHE_DB` | `~/.vega/cache.db` | Local cache DB (client mode) |
| `VEGA_OBSERVER_ENABLED` | `false` | Enable passive tool observation |
| `VEGA_TG_BOT_TOKEN` | — | Telegram bot token for alerts |
| `VEGA_TG_CHAT_ID` | — | Telegram chat ID for alerts |
| `VEGA_ENCRYPTION_KEY` | — | Hex key for encrypted exports |
| `VEGA_CLOUD_BACKUP_DIR` | — | Cloud backup sync directory |

> **Security reminder:** All secrets (`VEGA_API_KEY`, `VEGA_TG_BOT_TOKEN`, `VEGA_ENCRYPTION_KEY`) must be set via environment variables or `.env` file. Never commit them to version control.

---

## How It Works

### Memory Lifecycle

```
Create → Active Use → Cool Down → Archive/Merge → Cleanup
```

1. **Store**: Content is redacted (strip secrets) → embedded (Ollama bge-m3) → deduped (>0.85 similarity merges) → stored in SQLite
2. **Retrieve**: Query embedded → hybrid search (Vector 70% + BM25 30% via FTS5) → ranked by `similarity×0.5 + importance×0.3 + recency×0.2`
3. **Session**: `session_start` injects relevant context within a 2000-token budget. `session_end` extracts new memories from the summary
4. **Maintenance**: Daily backup, weekly compaction, embedding rebuild for gaps

### Trust System

| Status | Meaning | Search Weight |
|--------|---------|--------------|
| `verified` | User confirmed | ×1.0 |
| `unverified` | Auto-extracted, not yet reviewed | ×0.7 |
| `rejected` | User marked incorrect | Excluded |
| `conflict` | Contradicts existing verified memory | Surfaced for resolution |

### Cross-Project Sharing

Memories start as `project`-scoped. When accessed by 2+ different projects, they auto-promote to `global` scope and appear in all sessions.

---

## Development

### Build and test

```bash
rm -rf dist
npx tsc
node --test dist/tests/*.test.js
```

### Project structure

```
src/
├── index.ts              # MCP server entry
├── config.ts             # Configuration loader
├── core/                 # Memory, recall, session, compact, lifecycle
├── db/                   # SQLite schema, repository, backup, CRDT
├── embedding/            # Ollama integration, cache
├── search/               # Brute-force engine, ranking, hybrid search
├── security/             # Redactor, encryption, RBAC, keychain
├── mcp/                  # MCP tool definitions
├── cli/                  # CLI commands (commander.js)
├── api/                  # HTTP API routes, auth
├── web/                  # Dashboard
├── scheduler/            # Background daemon
├── insights/             # Pattern detection, insight generation
├── notify/               # Telegram, alert files
├── sync/                 # Remote client sync
├── plugins/              # Plugin loader, SDK
└── tests/                # Test suites
```

### Plugins

Plugins are discovered from `data/plugins/<plugin-name>/plugin.json`:

```json
{
  "name": "example-plugin",
  "version": "0.1.0",
  "main": "index.js"
}
```

Starter templates: `vega templates list` / `vega templates install <name>`.

---

## Security

- **Sensitive data redaction**: API keys, tokens, passwords are automatically stripped before storage
- **Encryption at rest**: Optional SQLCipher encryption with macOS Keychain key management
- **API authentication**: Bearer token required for all HTTP API calls
- **Audit logging**: Every operation is logged with actor, timestamp, and action
- **Graceful deletion**: Memories are never silently deleted — notification + download window + confirmation required
- **Network security**: For remote access, always use a VPN (Tailscale/WireGuard). Never expose the API port directly to the internet

---

## License

MIT
