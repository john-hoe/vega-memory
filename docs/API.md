# Vega Memory HTTP API

## Base URL

The API is served by the scheduler process:

```text
http://127.0.0.1:<VEGA_API_PORT>
```

Example:

```text
http://127.0.0.1:3271
```

## Authentication

- `GET /` is public and serves the dashboard.
- All `/api/*` routes require `Authorization: Bearer <VEGA_API_KEY>` when `VEGA_API_KEY` is configured.
- If no API key is configured, the API is open to local callers.

Example header:

```http
Authorization: Bearer change-me
Content-Type: application/json
```

## Error Model

Most JSON errors return:

```json
{
  "error": "message"
}
```

Typical status codes:

- `400` invalid request body, invalid query parameter, or unsupported sort
- `401` missing or invalid bearer token
- `500` internal server error

## Dashboard

### `GET /`

Serve the single-page Vega Memory dashboard.

Response:

- `200 text/html`

Notes:

- The page loads stats from `/api/health`.
- The page loads table rows from `/api/list`.
- The page submits searches to `/api/recall`.
- If the API is protected, the dashboard prompts for an API key and stores it in browser local storage.

## Memory Endpoints

### `POST /api/store`

Store a memory entry.

Request body:

```json
{
  "content": "Use better-sqlite3 for local persistence",
  "type": "decision",
  "project": "vega",
  "title": "SQLite choice",
  "tags": ["sqlite", "storage"],
  "importance": 0.9,
  "source": "explicit"
}
```

Fields:

- `content` required string
- `type` required one of `task_state`, `preference`, `project_context`, `decision`, `pitfall`, `insight`
- `project` optional string, defaults to `global`
- `title` optional string
- `tags` optional string array
- `importance` optional number between `0` and `1`
- `source` optional `auto` or `explicit`

Response:

```json
{
  "id": "memory-id",
  "action": "created",
  "title": "SQLite choice"
}
```

`action` can be:

- `created`
- `updated`
- `conflict`
- `queued`
- `excluded`

### `POST /api/recall`

Search relevant memories with hybrid recall.

Request body:

```json
{
  "query": "sqlite backup checklist",
  "project": "vega",
  "type": "pitfall",
  "limit": 5,
  "min_similarity": 0.3
}
```

Fields:

- `query` required string
- `project` optional string
- `type` optional memory type
- `limit` optional positive integer, default `5`
- `min_similarity` optional number between `0` and `1`, default `0.3`

Response:

```json
[
  {
    "id": "memory-id",
    "type": "pitfall",
    "project": "vega",
    "title": "Backup checklist",
    "content": "Checkpoint WAL before copying backups.",
    "importance": 0.7,
    "source": "explicit",
    "tags": ["sqlite", "backup"],
    "created_at": "2026-04-05T00:00:00.000Z",
    "updated_at": "2026-04-05T00:00:00.000Z",
    "accessed_at": "2026-04-05T00:00:00.000Z",
    "access_count": 3,
    "status": "active",
    "verified": "verified",
    "scope": "project",
    "accessed_projects": ["vega"],
    "similarity": 0.93,
    "finalScore": 0.89
  }
]
```

### `GET /api/list`

List memories.

Query parameters:

- `project` optional string
- `type` optional memory type
- `limit` optional positive integer, default `20`
- `sort` optional SQL-safe sort string such as `updated_at DESC` or `importance DESC`

Example:

```text
GET /api/list?project=vega&limit=50&sort=updated_at%20DESC
```

Response:

```json
[
  {
    "id": "memory-id",
    "type": "decision",
    "project": "vega",
    "title": "SQLite choice",
    "content": "Use better-sqlite3 for local persistence.",
    "importance": 0.9,
    "source": "explicit",
    "tags": ["sqlite", "storage"],
    "created_at": "2026-04-05T00:00:00.000Z",
    "updated_at": "2026-04-05T00:00:00.000Z",
    "accessed_at": "2026-04-05T00:00:00.000Z",
    "access_count": 0,
    "status": "active",
    "verified": "verified",
    "scope": "project",
    "accessed_projects": ["vega"]
  }
]
```

### `PATCH /api/memory/:id`

Update an existing memory.

Request body:

```json
{
  "title": "SQLite and backups",
  "content": "Checkpoint WAL before copying backups.",
  "importance": 0.8,
  "tags": ["sqlite", "backup"]
}
```

All fields are optional. Supported fields:

- `title`
- `content`
- `importance`
- `tags`

Response:

```json
{
  "id": "memory-id",
  "action": "updated"
}
```

### `DELETE /api/memory/:id`

Delete a memory.

Response:

```json
{
  "id": "memory-id",
  "action": "deleted"
}
```

## Session Endpoints

### `POST /api/session/start`

Load the session bundle for a working directory.

Request body:

```json
{
  "working_directory": "/Users/me/workspace/vega-memory",
  "task_hint": "dashboard auth flow"
}
```

Response:

```json
{
  "project": "vega-memory",
  "active_tasks": [],
  "preferences": [],
  "context": [],
  "relevant": [],
  "recent_unverified": [],
  "conflicts": [],
  "proactive_warnings": [],
  "token_estimate": 0
}
```

### `POST /api/session/end`

Store a session summary and extract durable memories.

Request body:

```json
{
  "project": "vega-memory",
  "summary": "Decided to expose the dashboard at / and keep API auth on /api/* only.",
  "completed_tasks": ["task-id-1"]
}
```

Response:

```json
{
  "project": "vega-memory",
  "action": "ended"
}
```

## Health and Maintenance

### `GET /api/health`

Return the expanded health payload used by the dashboard.

Response:

```json
{
  "status": "healthy",
  "ollama": true,
  "db_integrity": true,
  "memories": 42,
  "latency_avg_ms": 18.3,
  "db_size_mb": 1.27,
  "last_backup": "2026-04-05T02:11:34.000Z",
  "issues": [],
  "fix_suggestions": []
}
```

### `POST /api/compact`

Run compaction and return merge/archive counts.

Request body:

```json
{
  "project": "vega"
}
```

The request body is optional. When omitted, compaction runs across all projects.

Response:

```json
{
  "merged": 2,
  "archived": 5
}
```

## cURL Examples

### Health

```bash
curl -H "Authorization: Bearer change-me" \
  http://127.0.0.1:3271/api/health
```

### Store

```bash
curl -X POST http://127.0.0.1:3271/api/store \
  -H "Authorization: Bearer change-me" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Use better-sqlite3 for local persistence",
    "type": "decision",
    "project": "vega",
    "source": "explicit"
  }'
```

### Recall

```bash
curl -X POST http://127.0.0.1:3271/api/recall \
  -H "Authorization: Bearer change-me" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "better-sqlite3",
    "project": "vega",
    "limit": 5,
    "min_similarity": 0.3
  }'
```
