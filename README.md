**English** | [中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

# Vega Memory

Shared long-term memory infrastructure for AI coding agents.

Vega Memory is a local-first, self-hosted memory layer for Cursor, Codex, Claude Code, OpenClaw, and other MCP- or API-driven coding agents. It turns knowledge that normally disappears when a session ends into reusable engineering memory, so different tools, different machines, and different sessions can keep working from the same context.

If one agent fixes a problem today and another agent takes over tomorrow, Vega keeps the second one from starting at zero.

[Start in 5 minutes](#start-in-5-minutes) · [Access modes](#access-modes) · [Deployment](#deployment-paths) · [HTTP API](docs/API.md) · [Deployment docs](docs/deployment.md) · [Issues](https://github.com/john-hoe/vega-memory/issues)

Vega is best understood as a shared memory runtime underneath agent workflows, not as another generic note app or knowledge base.

## Why Vega

The real bottleneck in most agent workflows is not that the model is too weak. It is that the model forgets what happened last time.

Without a shared memory layer:

- each tool keeps its own context silo
- new sessions either load too much prompt context or miss critical context
- the same fixes, decisions, and pitfalls get rediscovered again and again
- remote machines, scripts, and background jobs cannot inherit local agent experience

Vega turns that into a reusable loop:

- inject relevant memory at task start with `session_start`
- keep storing reusable knowledge during work with `memory_store`
- capture summaries and extract durable lessons at task end with `session_end`
- reuse that knowledge later through `memory_recall` and session preload

## Who It Is For

Vega is currently the best fit for:

- solo developers using multiple coding agents in the same project and wanting each session to inherit prior decisions, pitfalls, and preferences
- small engineering teams that want a shared agent memory layer underneath daily coding workflows
- internal platform teams building self-hosted agent infrastructure with one memory backend exposed over MCP, CLI, and HTTP
- tool builders who need coding agents, scripts, and background services to reuse the same long-term memory

If your main problem is “multiple agents need shared context across sessions,” Vega is a much better fit than treating it as a generic knowledge platform.

## What Vega Is And Is Not

Vega is best understood as shared long-term memory infrastructure for coding agents.

- it is a memory runtime that stores and retrieves decisions, pitfalls, preferences, task state, and project context for agents
- it is not a generic human-first note app where freeform note capture is the primary job
- it is not a broad knowledge management suite where wiki authoring is the center of the product
- it is not a project tracker, chat history viewer, or general collaboration hub
- wiki, graph, analytics, and dashboard surfaces exist to support the memory runtime, not to replace that core identity

## Why Vega Stands Out

- **Infrastructure, not single-chat memory**: it serves multiple agents and multiple entry points, not just one conversation window
- **Local-first, not cloud-first**: SQLite and local model paths make it suitable for privacy-sensitive and offline workflows
- **Engineered, not demo-only**: MCP, CLI, HTTP API, dashboard, backup, audit, encryption, and sync already exist
- **Focused on workflow continuity**: the goal is not just to store notes, but to make the next agent actually remember

## Core Capabilities

- **Shared memory primitives**: `memory_store`, `memory_recall`, `memory_list`, `session_start`, `session_end`
- **Hybrid retrieval**: vector search, BM25, reranking, topic-aware recall, deep recall
- **Operational reliability**: version history, audit logs, compaction, backups, database encryption
- **Multiple access surfaces**: MCP, CLI, HTTP API, dashboard
- **Upper-layer capabilities**: wiki synthesis, graph views, multi-tenant controls, analytics, and more

## Runtime Environment

- **Recommended runtime**: Node 20 LTS
- **Default storage**: SQLite, local-first, with `./data/memory.db` as the default database path
- **Default embedding path**: Ollama + `bge-m3`
- **Fallback behavior**: Vega still runs without Ollama, but retrieval falls back to more conservative keyword / non-vector paths

## Access Modes

| Mode | Transport | Best fit |
| --- | --- | --- |
| MCP | stdio | native agent integration in Cursor and other MCP clients |
| CLI | shell | Codex, Claude Code, scripts, CI, local terminal workflows |
| HTTP API | REST | remote machines, dashboard access, custom integrations, sync clients |

The practical rule of thumb is simple:

- want agents to call memory automatically: use MCP
- want scripts or terminal workflows: use the CLI
- want remote sharing or background services: use the HTTP API

## A Typical Workflow

1. An agent starts a task and calls `session_start`
2. Vega returns active tasks, preferences, relevant memories, and proactive warnings
3. During work, the agent records reusable lessons with `memory_store`
4. At the end, the agent calls `session_end` to store the summary and extract knowledge
5. The next agent reuses that same memory on the next session

That loop is the core product.

## Start In 5 Minutes

### 1. Clone and build

```bash
git clone https://github.com/john-hoe/vega-memory.git
cd vega-memory
npm install
npm run build
npm link
```

### 2. Set the minimum environment

```bash
cp .env.example .env
```

A common local setup looks like this:

```bash
VEGA_DB_PATH=./data/memory.db
VEGA_DB_ENCRYPTION=false
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=bge-m3
VEGA_API_KEY=change-me
VEGA_API_PORT=3271
```

### 3. Verify the install

```bash
vega health
```

### 4. Run the smallest memory loop

```bash
vega health

vega store "Always checkpoint WAL before copying SQLite backups" \
  --type pitfall \
  --project my-project \
  --title "SQLite backup checklist"

vega recall "sqlite backup" --project my-project

vega session-start --dir "$(pwd)" --mode L1 --json
```

That is the canonical five-minute proof: the service is healthy, you can store a durable fact, you can recall it, and a coding agent can preload it at task start.

### 5. Connect one agent surface

Use the setup helper that matches the workflow you want next:

```bash
vega setup --codex
vega setup --claude
vega setup --show
```

If you are wiring a shared remote Vega server into Cursor client mode, use:

```bash
vega setup --server 127.0.0.1 --port 3271 --cursor
```

## Deployment Paths

Vega currently has three recommended deployment paths.

### Option A: Local single-machine mode

Best for solo developers and local workflows.

- SQLite is the primary local store
- the MCP entrypoint is started on demand by the client
- the scheduler process provides the HTTP API, dashboard, backups, and maintenance

```bash
export VEGA_API_KEY="$(openssl rand -hex 16)"
node dist/scheduler/index.js
```

### Option B: Docker / Compose

Best for people who want to try the full stack quickly.

```bash
docker compose up --build
```

The current Compose file starts:

- `vega`: scheduler + HTTP API
- `ollama`: local model service

Note that the checked-in Compose file exposes port `3000`, not the default documented `3271`.

### Option C: Remote shared mode

Best for multiple machines or small teams sharing the same memory base.

- run Vega centrally in server mode
- access it through the HTTP API or client mode
- keep local cache plus remote sync behavior

## Best First Use Cases

If you are trying Vega for the first time, start with one of these:

- let Cursor, Codex, and Claude Code share pitfalls in the same repository
- persist decisions and preferences for long-lived projects instead of leaving them in temporary chat history
- create a shared agent memory backend for a self-hosted team environment
- make `session_start` the default context entrypoint before work begins

## Technical Boundaries And Honest Expectations

To avoid misleading first impressions, these boundaries are worth stating clearly:

- Vega is SQLite-first today; remote and multi-machine sharing are layered on through API and sync paths
- the HTTP API and dashboard only start when `VEGA_API_KEY` is explicitly configured
- the dashboard is served by the scheduler process, not by a separate frontend app
- Ollama is the default embedding/provider path, but other providers can be configured
- the remote MCP client is currently a lightweight compatibility layer, not a full mirror of local MCP coverage
- wiki, graph, analytics, billing, and similar features exist, but they are not the main learning path for first adoption

## Architecture Overview

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

## Where To Go Next

- want the API surface: see [HTTP API docs](docs/API.md)
- want deployment details: see [deployment docs](docs/deployment.md)
- want the product metrics model: see [impact model](docs/impact-model.md)
- want to run a real-user trial: see [trial feedback playbook](docs/trial-feedback-playbook.md)
- want agent-specific integration steps: continue into the lower sections of this README
- want to report issues: use [GitHub Issues](https://github.com/john-hoe/vega-memory/issues)
- want community discussion: the next documentation improvement should add a clearer discussions/docs funnel
