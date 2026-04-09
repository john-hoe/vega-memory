# VM2 Adapter Guide

VM2 uses one recall protocol across adapters:

1. `session_start(mode)` for bounded preload.
2. `recall(query)` for hot, task-specific retrieval.
3. `deep_recall(request)` for archived/original evidence.
4. `session_end(...)` for closeout and durable extraction.

The service owns token budgeting. Adapters should pick the smallest preload mode that fits the turn, then fetch more with `recall` instead of preloading everything.

## Mode Matrix

| Mode | Use it for | Expected preload shape |
| --- | --- | --- |
| `L0` | Identity-only follow-up turns | Preferences only |
| `L1` | Routine coding and small task turns | Preferences, active tasks, conflicts, proactive warnings |
| `L2` | Planning, architecture, new repo areas, wider synthesis | Standard hot bundle |
| `L3` | Audit, provenance, archived evidence | `L2` plus automatic `deep_recall` |

`light` is the alias for `L1`. `standard` is the alias for `L2`.

## Claude Code Adapter

Claude Code should stay on `L1` for normal coding turns, then use `recall` for missing facts.

### Recommended mode policy

- `L0`: Fast follow-up turns when Claude Code already has the file-local context and only needs preference reminders.
- `L1`: Default mode for daily coding, bugfixes, short edit/test loops, and most incremental work.
- `L2`: Planning, architecture review, ambiguous tasks, repo-wide cleanup, or unfamiliar repo areas.
- `L3`: Audit, provenance, original-text lookup, or evidence-heavy debugging.

### CLI-first workflow

```bash
vega session-start --dir "$(pwd)" --mode L1 --json
vega recall "sqlite backup checklist" --project vega-memory --limit 5 --min-similarity 0.3 --json
vega store "Claude adapter validation completed." --type task_state --project vega-memory --title "VM2-013 Claude adapter validation"
vega session-end --project vega-memory --summary "Validated the Claude Code adapter flow and documented L0/L1/L2/L3 usage."
```

### `deep_recall` example

If Claude Code is connected through the MCP server, call `deep_recall` only when archived/original evidence is required:

```json
{
  "tool": "deep_recall",
  "arguments": {
    "query": "backup restore evidence",
    "project": "vega-memory",
    "limit": 3,
    "evidence_limit": 2,
    "include_content": true,
    "include_metadata": true,
    "inject_into_session": false
  }
}
```

If the host only exposes HTTP, send the same payload to `POST /api/deep-recall`.

## OpenClaw Adapter

OpenClaw should use the HTTP API templates directly and stay biased toward `L0` plus aggressive `recall` when tokens are tight.

### Token-pressure strategy

- Severe token pressure or very recent local state: start with `L0`, then call `recall` immediately for task-specific facts.
- Moderate token pressure: use `L1` if active tasks/conflicts still matter.
- New repo area or broader project context needed: use `L2`.
- Evidence-heavy turn: use `L3` only when archive evidence must arrive in the preload; otherwise keep `L0` or `L1` and call `POST /api/deep-recall` explicitly.

### Two-stage HTTP example

```bash
curl -sS http://127.0.0.1:3271/api/session/start \
  -H 'Authorization: Bearer change-me' \
  -H 'Content-Type: application/json' \
  -d '{
    "working_directory": "/Users/me/workspace/vega-memory",
    "task_hint": "adapter token budget",
    "mode": "L0"
  }'
```

```bash
curl -sS http://127.0.0.1:3271/api/recall \
  -H 'Authorization: Bearer change-me' \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "adapter token budget",
    "project": "vega-memory",
    "limit": 5,
    "min_similarity": 0.3
  }'
```

OpenClaw should store durable events with `POST /api/store` and close the turn with `POST /api/session/end` once the task is done or a checkpoint summary is ready.

## Hermes Adapter

Hermes is a reserved orchestration adapter. The transport can be MCP or HTTP, but the mode policy should already be fixed.

### Orchestration turn policy

- `L0`: Routing, dispatch, worker selection, status polling, or quick follow-up turns.
- `L1`: Single-lane execution turns where Hermes already knows the active working set.
- `L2`: Planning, architecture, multi-lane synthesis, or broader coordination turns.
- `L3`: Audit packets, provenance review, or archived evidence expansion.

### Delegation handoff rule

- Trigger `session_end` immediately after Hermes produces a durable delegation handoff packet, end-of-turn summary, or checkpoint another agent will consume.
- Do not wait for the full orchestration tree to finish if the current Hermes turn has ended.
- If a downstream worker completes an independent work unit, that worker should emit its own `session_end` for its local summary.

## Token Comparison Report

Run the focused token comparison script after `npm run build`:

```bash
node scripts/generate-adapter-token-report.mjs
```

The script prints a markdown report comparing `L0`, `L1`, `L2`, and `L3` `token_estimate` values and the step-up curve between adjacent modes.
