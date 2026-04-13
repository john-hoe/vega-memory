# Vega Memory Deployment

Vega is best deployed as shared long-term memory infrastructure for coding agents. This guide covers how to run the same backend behind MCP, CLI, and HTTP so Cursor, Codex, Claude Code, scripts, and remote services can reuse one memory base.

Use this guide when your problem is cross-session agent continuity. If you mainly need a generic note app, human-first wiki, or project tracker, Vega overlaps with that space but is not positioned as that product.

## Quick Start

Install dependencies, build the project, then start the MCP entrypoint:

```bash
npm install
npm run build
node dist/index.js
```

For HTTP API, dashboard, backups, and scheduled maintenance, run the scheduler process with an API key:

```bash
export VEGA_API_KEY="$(openssl rand -hex 16)"
node dist/scheduler/index.js
```

Default local values:

- `VEGA_DB_PATH=./data/memory.db`
- `OLLAMA_BASE_URL=http://localhost:11434`
- `VEGA_API_PORT=3271`
- `OLLAMA_MODEL=bge-m3`

## Docker Deployment

Build and start the stack:

```bash
docker compose up --build
```

The provided [`docker-compose.yml`](../docker-compose.yml) starts:

- `vega`: scheduler + HTTP API on port `3000`
- `ollama`: Ollama server on port `11434`

Minimal `.env` example:

```bash
VEGA_API_KEY=change-me-to-a-random-secret
OLLAMA_BASE_URL=http://ollama:11434
```

Important behavior:

- The container stores SQLite data in `./data`
- The compose health check calls `GET /api/health`
- The health check must send `Authorization: Bearer $VEGA_API_KEY`

## Environment Variables

Core runtime:

| Variable | Default | Description |
| --- | --- | --- |
| `VEGA_DB_PATH` | `./data/memory.db` | SQLite database path |
| `VEGA_API_KEY` | unset | Required to enable the authenticated HTTP API |
| `VEGA_API_PORT` | `3271` | HTTP API port |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama base URL |

OpenAI embedding mode:

| Variable | Default | Description |
| --- | --- | --- |
| `VEGA_OPENAI_API_KEY` | unset | OpenAI or compatible API key |
| `VEGA_OPENAI_BASE_URL` | unset | Override base URL for Azure/OpenAI-compatible providers |
| `VEGA_OPENAI_EMBEDDING_MODEL` | unset | Embedding model name when `VEGA_EMBEDDING_PROVIDER=openai` |

OIDC:

| Variable | Default | Description |
| --- | --- | --- |
| `VEGA_OIDC_ISSUER_URL` | unset | OIDC issuer discovery URL |
| `VEGA_OIDC_CLIENT_ID` | unset | OIDC client ID |
| `VEGA_OIDC_CLIENT_SECRET` | unset | OIDC client secret |
| `VEGA_OIDC_CALLBACK_URL` | unset | Callback URL, typically `http://HOST:PORT/api/auth/oidc/callback` |

Slack:

| Variable | Default | Description |
| --- | --- | --- |
| `VEGA_SLACK_WEBHOOK_URL` | unset | Slack incoming webhook URL |
| `VEGA_SLACK_BOT_TOKEN` | unset | Slack bot token |
| `VEGA_SLACK_CHANNEL` | unset | Default Slack channel |
| `VEGA_SLACK_ENABLED` | `false` | Enable Slack notifications |

Related variables commonly used in production:

| Variable | Default | Description |
| --- | --- | --- |
| `OLLAMA_MODEL` | `bge-m3` | Embedding model loaded from Ollama |
| `VEGA_EMBEDDING_PROVIDER` | `ollama` | `ollama` or `openai` |
| `VEGA_MODE` | `server` | `server` or `client` |
| `VEGA_SERVER_URL` | unset | Remote Vega server URL in client mode |
| `VEGA_CACHE_DB` | `~/.vega/cache.db` | Client-side cache database |
| `VEGA_DB_ENCRYPTION` | `false` | Enable encrypted SQLite mode |
| `VEGA_ENCRYPTION_KEY` | unset | Encryption key when DB encryption is enabled |

## MCP / Agent Integration

These integration paths all point back to the same underlying memory service. Pick the surface that matches how your coding agents work today, rather than treating the deployment as a separate product tier.

If you want the quickest CLI-first onboarding path, use the setup helpers first and then confirm the local status:

```bash
vega setup --codex
vega setup --claude
vega setup --show
```

If Vega is already running as a shared server and you want Cursor in remote client mode, use:

```bash
vega setup --server 127.0.0.1 --port 3271 --cursor
vega setup --show
```

## Integration Surface Status

`vega setup --show`, `vega doctor`, and the dashboard now use the same three-dimensional status model for each surface:

- `managed_setup_status`: whether the official Vega-managed setup path is complete
- `observed_activity_status`: whether recent tagged activity has been observed for that surface
- `runtime_health_status`: whether the surface is currently healthy enough to work

Supported surfaces currently include Cursor, Codex, Claude Code, HTTP / API, and CLI.

Important interpretation rules:

- configured setup does not guarantee real usage
- real usage does not guarantee the managed setup is complete
- `missing + active` is a valid state when a surface is being used outside the managed setup path
- `unknown` means the system does not yet have reliable attribution data for that surface; it is not treated as an error

### Cursor

Add Vega as an MCP server in `~/.cursor/mcp.json`:

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

### Claude Code

This repository currently documents Claude Code with the CLI flow rather than a dedicated MCP config. Add rules to `CLAUDE.md`:

```markdown
# Vega Memory Rules

- Start: `vega session-start --dir $(pwd) --json`
- Recall before changes: `vega recall "query" --project PROJECT --json`
- Task done: `vega store "..." --type task_state --project PROJECT --title "..."`
- Decision: `vega store "..." --type decision --project PROJECT --title "..."`
- Bug fixed: `vega store "..." --type pitfall --project PROJECT --title "..."`
- End: `vega session-end --project PROJECT --summary "..."`
```

If your Claude Code host supports arbitrary MCP stdio servers, reuse the same `node dist/index.js` command shown in the Cursor example.

### Codex

Codex uses the same CLI-first memory workflow. `vega setup --codex` installs a managed Vega Memory rules section into `~/.codex/AGENTS.md`, and `vega setup --show` reports whether the Codex, Claude, and Cursor surfaces are currently configured, partial, or missing.

## Ollama Model Download

Pull the default embedding model before running recall-heavy workflows:

```bash
ollama pull bge-m3
```

Verify Ollama is reachable:

```bash
curl http://localhost:11434/api/tags
```

## Backup Recommendations

Vega stores its primary shared memory state in the SQLite database file pointed to by `VEGA_DB_PATH`.

Recommended backups:

- Back up the main `.db` file regularly
- Stop writes or checkpoint WAL before copying hot databases in strict environments
- Back up the whole data directory if you also want `-wal`, `-shm`, or local backup artifacts
- Keep encrypted and unencrypted databases separate

Example:

```bash
cp ./data/memory.db ./backups/memory-$(date +%F).db
```

## Troubleshooting

If the deployment behaves unlike a shared agent memory service, first verify that the runtime surface matches the workflow you intended:

- use MCP when coding agents should call memory tools automatically
- use the CLI for shell-driven workflows and explicit scripting
- use the HTTP API when multiple machines or background services must reach the same memory backend

### `GET /api/health` returns `401 unauthorized`

- Set `VEGA_API_KEY`
- Send `Authorization: Bearer $VEGA_API_KEY`
- Confirm Docker health checks include the header

### OIDC login returns `oidc is not configured`

- Set all `VEGA_OIDC_*` variables
- Ensure the callback URL matches `/api/auth/oidc/callback`
- Verify the issuer discovery endpoint is reachable from the server

### Ollama is unavailable

- Start the Ollama daemon
- Confirm `OLLAMA_BASE_URL` points to the correct host and port
- Pull `bge-m3` or your configured model before the first recall

### Startup or session commands fail with schema errors such as `no such column: space_id`

- The database file is older than the current schema
- Start with a fresh SQLite file, or migrate the existing database before reuse
- Confirm `VEGA_DB_PATH` points to the database you intended to upgrade

### Dashboard or admin APIs return `403 forbidden`

- Verify the request is authenticated as an `admin` user session
- Root bearer API keys can access admin endpoints, but member dashboard sessions cannot

### Docker stack is up but embeddings do not work

- Check that the `ollama` container is healthy
- Confirm `OLLAMA_BASE_URL=http://ollama:11434` inside Compose
- Run `docker compose logs ollama` and `docker compose logs vega`
