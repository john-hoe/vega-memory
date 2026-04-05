# Vega Memory HTTP API

## Base URL

The scheduler hosts the API on:

```text
http://127.0.0.1:<VEGA_API_PORT>
```

Example:

```text
http://127.0.0.1:3271
```

## Authentication

- The scheduler only starts the HTTP API when `VEGA_API_KEY` is configured.
- `GET /` returns the dashboard when the request is authenticated, or a login form when it is not.
- Requests to `/api/*` accept either `Authorization: Bearer <VEGA_API_KEY>` or the authenticated dashboard session cookie.
- `POST /dashboard/login` exchanges the API key for an HttpOnly dashboard session cookie.
- `POST /dashboard/logout` clears the dashboard session cookie.

Example headers:

```http
Authorization: Bearer change-me
Content-Type: application/json
```

## Error Format

Most failures return JSON like:

```json
{
  "error": "message"
}
```

Common status codes:

- `400` invalid JSON, invalid request body, or invalid query parameter
- `401` missing or invalid bearer token
- `500` internal server error

## `GET /`

Serve the Vega Memory dashboard after authentication, or return the login form with `401 text/html` when the browser has not authenticated yet.

Example request:

```http
GET /
```

Example response:

- `200 text/html`

Notes:

- The dashboard fetches stats from `GET /api/health`.
- It fetches memory rows from `GET /api/list`.
- It submits searches to `POST /api/recall`.
- Successful login sets an HttpOnly cookie, so the dashboard does not store the API key in `localStorage`.

## `POST /dashboard/login`

Authenticate the dashboard and set the session cookie used by browser requests.

Example request:

```http
POST /dashboard/login
Content-Type: application/x-www-form-urlencoded
```

```text
apiKey=change-me
```

Example response:

- `302` redirect to `/` on success
- `401 text/html` with the login page on failure

## `POST /dashboard/logout`

Clear the dashboard session cookie and redirect back to the login page.

Example request:

```http
POST /dashboard/logout
```

Example response:

- `302` redirect to `/`

## `POST /api/store`

Store a memory entry.

Example request:

```http
POST /api/store
Content-Type: application/json
Authorization: Bearer change-me
```

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

Request fields:

- `content` required string
- `type` required one of `task_state`, `preference`, `project_context`, `decision`, `pitfall`, `insight`
- `project` optional string, defaults to `global`
- `title` optional string
- `tags` optional string array
- `importance` optional number from `0` to `1`
- `source` optional `auto` or `explicit`

Example response:

```json
{
  "id": "memory-id",
  "action": "created",
  "title": "SQLite choice"
}
```

`action` may be `created`, `updated`, `conflict`, `queued`, or `excluded`.

## `POST /api/recall`

Recall relevant memories.

Example request:

```http
POST /api/recall
Content-Type: application/json
Authorization: Bearer change-me
```

```json
{
  "query": "sqlite backup checklist",
  "project": "vega",
  "type": "pitfall",
  "limit": 5,
  "min_similarity": 0.3
}
```

Request fields:

- `query` required string
- `project` optional string
- `type` optional memory type
- `limit` optional positive integer, defaults to `5`
- `min_similarity` optional number from `0` to `1`, defaults to `0.3`

Example response:

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

## `GET /api/list`

List memories.

Example request:

```http
GET /api/list?project=vega&limit=20&sort=updated_at%20DESC
Authorization: Bearer change-me
```

Query parameters:

- `project` optional string
- `type` optional memory type
- `limit` optional positive integer, defaults to `20`
- `sort` optional SQL-safe sort expression such as `updated_at DESC` or `importance DESC`

Example response:

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

## `PATCH /api/memory/:id`

Update an existing memory.

Example request:

```http
PATCH /api/memory/memory-id
Content-Type: application/json
Authorization: Bearer change-me
```

```json
{
  "content": "Checkpoint WAL before copying backups.",
  "importance": 0.8,
  "tags": ["sqlite", "backup"]
}
```

Supported fields:

- `content`
- `importance`
- `tags`

Example response:

```json
{
  "id": "memory-id",
  "action": "updated"
}
```

## `DELETE /api/memory/:id`

Delete a memory.

Example request:

```http
DELETE /api/memory/memory-id
Authorization: Bearer change-me
```

Example response:

```json
{
  "id": "memory-id",
  "action": "deleted"
}
```

## `POST /api/session/start`

Load the session bundle for a working directory.

Example request:

```http
POST /api/session/start
Content-Type: application/json
Authorization: Bearer change-me
```

```json
{
  "working_directory": "/Users/me/workspace/vega-memory",
  "task_hint": "dashboard auth flow"
}
```

Example response:

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

## `POST /api/session/end`

Store a session summary and extract durable memories.

Example request:

```http
POST /api/session/end
Content-Type: application/json
Authorization: Bearer change-me
```

```json
{
  "project": "vega-memory",
  "summary": "Moved the dashboard to cookie-backed auth and removed unsafe HTML rendering.",
  "completed_tasks": ["task-id-1"]
}
```

Example response:

```json
{
  "project": "vega-memory",
  "action": "ended"
}
```

## `GET /api/health`

Return the health payload used by the dashboard.

Example request:

```http
GET /api/health
Authorization: Bearer change-me
```

Example response:

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

`status` is one of `healthy`, `degraded`, or `unhealthy`.

## `POST /api/compact`

Run memory compaction.

Example request:

```http
POST /api/compact
Content-Type: application/json
Authorization: Bearer change-me
```

```json
{
  "project": "vega"
}
```

The request body is optional. If omitted, compaction runs across all projects.

Example response:

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
