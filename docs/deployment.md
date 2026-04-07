# Vega Memory Deployment

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

The provided [`docker-compose.yml`](/Users/johnmacmini/workspace/vega-memory/docker-compose.yml) starts:

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

Vega stores its primary state in the SQLite database file pointed to by `VEGA_DB_PATH`.

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
