# VM2-001 Recall Protocol

Status: accepted design spec  
Scope: protocol, request/response contracts, transport compatibility, client trigger rules  
Non-goal: change the current `standard` session loading behavior

## 1. Goal

VM2 introduces a unified two-stage recall protocol for all clients:

1. `session_start(mode)` loads a bounded preload bundle.
2. `recall(query)` performs hot semantic retrieval on demand.
3. `deep_recall(request)` is reserved for cold evidence retrieval and original-text fetches.
4. `session_end(...)` remains the closeout step for durable extraction and task completion.

The key design change is that token-budget enforcement moves to the service side. Clients choose a mode and trigger stage-two retrieval when needed; they do not assemble preload bundles themselves.

## 2. Confirmed Current Baseline

The current code confirms these baseline behaviors:

- `SessionService.sessionStart()` builds the full preload bundle and uses `tokenBudget` with fixed ratios from `SESSION_BUDGET_RATIOS` in [session.ts](/Users/johnmacmini/workspace/vega-memory/src/core/session.ts).
- `RecallService.recall()` is the existing hot semantic recall path in [recall.ts](/Users/johnmacmini/workspace/vega-memory/src/core/recall.ts).
- HTTP `POST /api/recall` returns a full serialized memory record plus scoring in [routes.ts](/Users/johnmacmini/workspace/vega-memory/src/api/routes.ts).
- MCP `memory_recall` currently returns a reduced record in [server.ts](/Users/johnmacmini/workspace/vega-memory/src/mcp/server.ts).

VM2-001 does not change the current `standard` preload result. It adds protocol types, transport acceptance for `mode`, and the reserved `deep_recall` error contract.

## 3. Two-Stage Flow

```text
client turn starts
  -> session_start(mode = light | standard)
      -> server applies preload budget policy
      -> returns bounded session context
  -> client works with returned bundle
      -> if more task-specific context is needed
         -> recall(query)
             -> server runs hot semantic recall
             -> returns ranked memory hits
      -> if archived/original evidence is needed
         -> deep_recall(request)
             -> VM2-001: 501 Not Implemented
             -> VM2-006: cold retrieval path
  -> session_end(summary, completed_tasks?)
      -> durable extraction / task closeout
```

## 4. Canonical Protocol

### 4.1 `session_start`

Request:

```json
{
  "working_directory": "/abs/path/to/project",
  "task_hint": "optional user intent",
  "mode": "standard"
}
```

Request fields:

- `working_directory`: required absolute or relative workspace path
- `task_hint`: optional free-text hint used for relevance shaping
- `mode`: optional, `standard` or `light`, defaults to `standard`

#### `standard`

`standard` maps to the current behavior and current response shape:

```json
{
  "project": "vega-memory",
  "active_tasks": "Memory[]",
  "preferences": "Memory[]",
  "context": "Memory[]",
  "relevant": "Memory[]",
  "relevant_wiki_pages": "SessionStartWikiPage[]",
  "wiki_drafts_pending": 0,
  "recent_unverified": "Memory[]",
  "conflicts": "Memory[]",
  "proactive_warnings": ["string"],
  "token_estimate": 0
}
```

#### `light`

Canonical light-mode preload contents:

- `preferences`, ordered by `importance DESC`
- `active_tasks`
- `critical_conflicts`, defined as memories with `verified === "conflict"`
- `proactive_warnings`
- `token_estimate`

Canonical light-mode exclusions:

- `context`
- `relevant`
- `recent_unverified`
- `relevant_wiki_pages`
- `wiki_pages`

Compatibility note:

- VM2-001 keeps the existing transport response shape for runtime compatibility.
- The current implementation accepts `mode: "light"` but still returns the existing `SessionStartResult` shape.
- Until the light payload branch ships, clients should derive canonical `critical_conflicts` from the existing `conflicts` field.

### 4.2 `recall`

Purpose: hot semantic retrieval from active memory storage.

Canonical request:

```json
{
  "query": "sqlite backup checklist",
  "project": "vega",
  "type": "pitfall",
  "limit": 5,
  "min_similarity": 0.3
}
```

Canonical request fields:

- `query`: required string
- `project`: optional project scope
- `type`: optional memory-type filter
- `limit`: optional positive integer, default `5`
- `min_similarity`: optional number `0..1`, default `0.3`

Canonical response item:

```json
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
```

Compatibility note:

- HTTP already matches the canonical rich response.
- MCP `memory_recall` is currently narrower and does not yet expose the full canonical shape.
- VM2-001 documents the unified target contract but does not rewrite the MCP output surface.

### 4.3 `deep_recall`

Purpose: cold/archive retrieval for original text, provenance, or evidence that should not be injected into session context by default.

Canonical request:

```json
{
  "query": "sqlite backup evidence",
  "project": "vega",
  "limit": 3,
  "evidence_limit": 2,
  "include_content": true,
  "include_metadata": true,
  "inject_into_session": false
}
```

Canonical request fields:

- `query`: required string
- `project`: optional project scope
- `limit`: optional positive integer for top-level hits
- `evidence_limit`: optional positive integer for evidence expansions per hit
- `include_content`: optional boolean
- `include_metadata`: optional boolean
- `inject_into_session`: optional boolean, default `false`

Canonical success response shape:

```json
{
  "results": [
    {
      "memory_id": "memory-id",
      "project": "vega",
      "type": "pitfall",
      "title": "Backup checklist",
      "content": "Full archived content or evidence excerpt",
      "summary": "Optional summary",
      "verified": "verified",
      "created_at": "2026-04-05T00:00:00.000Z",
      "updated_at": "2026-04-05T00:00:00.000Z",
      "evidence_score": 0.82
    }
  ],
  "next_cursor": null,
  "injected_into_session": false
}
```

VM2-001 runtime behavior:

- HTTP `POST /api/deep-recall` returns `501 Not Implemented`
- implementation is deferred to VM2-006

### 4.4 `session_end`

`session_end` remains unchanged. Its role in the two-stage protocol is:

- close the active turn or work unit
- persist summary-derived memories
- mark completed task IDs
- keep the preload/recall pipeline stateless between turns

`session_end` is not part of hot or deep retrieval. It is the closeout step after either one-stage or two-stage recall usage.

## 5. Budget Policy

### 5.1 Standard budget

Server-owned budget source:

- `tokenBudget` from config
- current default: `2000`

Current standard ratios:

- preferences: `10%`
- active tasks: `20%`
- context: `20%`
- remaining budget: `recent_unverified`, `conflicts`, then ranked `relevant`
- `relevant_wiki_pages` are estimated separately in `token_estimate`

### 5.2 Light budget

Light mode target cap:

- `floor(tokenBudget * 0.25)`
- with the current default budget, the light cap is `500`

Light mode loading order:

1. `preferences`
2. `active_tasks`
3. `critical_conflicts`
4. `proactive_warnings`

Light mode rules:

- budget enforcement is service-side
- clients should not trim or rank preload entries locally
- task-specific relevance should be fetched with `recall(query)`
- deep evidence should be fetched with `deep_recall(...)`

## 6. Error Codes

Canonical protocol errors:

| HTTP | Code | Meaning |
| --- | --- | --- |
| `400` | `INVALID_RECALL_MODE` | invalid `session_start.mode` |
| `422` | `INVALID_RECALL_REQUEST` | malformed or semantically invalid recall payload |
| `429` | `TOKEN_BUDGET_EXCEEDED` | future guard for hard budget ceilings |
| `501` | `DEEP_RECALL_NOT_IMPLEMENTED` | reserved cold-recall path not implemented yet |

Canonical error body:

```json
{
  "error": {
    "status": 501,
    "code": "DEEP_RECALL_NOT_IMPLEMENTED",
    "message": "deep_recall is reserved for VM2-006 and is not implemented yet",
    "retryable": false
  }
}
```

## 7. MCP Schema

VM2-001 extends the `session_start` MCP tool schema with `mode`:

```json
{
  "working_directory": "string",
  "task_hint": "string?",
  "mode": "\"light\" | \"standard\" = \"standard\""
}
```

Rules:

- omitted `mode` is treated as `standard`
- `standard` preserves the current result behavior
- `light` is accepted at the transport level in VM2-001 to make the contract real and forward-compatible

`memory_recall` remains the MCP hot recall tool in VM2-001. No `deep_recall` MCP tool is introduced in this task.

## 8. Client Trigger Matrix

| Client | `session_start(light)` | `session_start(standard)` | `recall` | `deep_recall` | `session_end` |
| --- | --- | --- | --- | --- | --- |
| Claude Code | default for routine coding turns, small bugfixes, and follow-up turns that already have local code context | use for planning, architecture review, ambiguous tasks, repo-wide cleanup, or when the first light preload is insufficient | after the initial preload when task-specific facts are missing | only for provenance/original-text requests, audit evidence, or archived context; expect `501` in VM2-001 | when the user-visible task is complete or a meaningful handoff summary exists |
| OpenClaw | default when token pressure is high or the tool already has recent local state | use when entering a new repo area or when project context is likely to matter | use aggressively after light preload instead of promoting preload size | use only when a user explicitly asks for original evidence or archived detail | on task completion or durable checkpoint |
| Hermes | default for orchestration / routing turns where fast context hydration matters more than completeness | use for long-form reasoning turns, synthesis, or when multiple memory classes must be visible immediately | use when the downstream agent asks for targeted retrieval | use for evidence pull requests or cold-storage expansion; expect `501` in VM2-001 | after summarization, delegation handoff, or end-of-turn memory extraction |

## 9. Migration Notes

- Existing clients that omit `mode` stay on `standard`.
- Clients may begin sending `mode: "light"` immediately without breaking the current runtime.
- Canonical light payload shaping can ship later without changing the request contract.
- `deep_recall` is intentionally defined ahead of implementation so clients can code against the endpoint and error code now.
