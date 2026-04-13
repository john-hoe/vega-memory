# Vega Impact Model

## Goal

Measure whether Vega is creating real coding-agent continuity instead of just collecting more stored memories.

The model should answer four product questions:

1. Did a user reach first value?
2. Did Vega help in a later session, not just the first one?
3. What kind of memories created the most practical leverage?
4. Which setup or adoption gaps still prevent repeat usage?

## Principles

- Prefer product-value metrics over infrastructure vanity metrics
- Separate "available now" metrics from metrics that need new telemetry
- Make every metric reusable across CLI, JSON, dashboard, and weekly summaries
- Keep the MVP readable by one operator in under a minute

## Surfaces

The same model should feed three outputs:

- `vega impact`: a current-value snapshot
- `vega weekly`: a period summary with deltas and top signals
- dashboard cards: a compact operator view for setup, reuse, and trend signals

## Metric Groups

| Group | Product question |
| --- | --- |
| Activation | Did the user reach a first successful loop? |
| Reuse | Did later sessions reuse prior memory? |
| Memory quality | Which memory types create practical value? |
| Adoption coverage | Which agent surfaces are actually connected? |
| Expansion | Is usage spreading across projects or users? |

## MVP Metrics

These are the metrics that should power the first usable Phase 4 outputs because the current codebase can already compute them or is one thin layer away from doing so.

| Metric | Definition | Why it matters | Current source |
| --- | --- | --- | --- |
| `active_projects` | Count of projects with recent activity or memories | Shows whether Vega matters in more than one isolated repo | existing analytics usage stats |
| `new_memories_this_week` | Memories created during the current 7-day window | Shows whether users are still capturing new durable context | repository created_at timestamps |
| `top_reused_memories` | Highest-value memories by access signal | Shows whether stored memory is actually being pulled back into work | existing access_count and weekly report data |
| `memory_mix` | Count of pitfall / decision / task_state / preference / project_context | Shows what kind of knowledge users rely on most | existing memory type counts |
| `setup_surface_coverage` | Per-surface state for Codex / Claude / Cursor (`configured`, `partial`, `missing`) | Shows whether adoption is blocked by integration setup | setup/doctor shared status model |
| `runtime_readiness` | Health status for Node, mode, API key, and Ollama | Shows whether failures are product friction or environment friction | `vega doctor` |

## Next Metrics

These metrics are important, but Phase 4 should treat them as explicit next-step telemetry work rather than pretending they already exist.

| Metric | Definition | Missing data or work |
| --- | --- | --- |
| `first_value_time` | Time from setup start to first useful recall or session preload | Need an event for setup start and first successful recall/session-start |
| `session_start_hit_rate` | Percent of session_start payloads that users report as useful | Need explicit session outcome feedback or event tagging |
| `pitfall_hit_rate` | Percent of recalled results that are pitfall memories and then reused successfully | Need recall-result attribution and follow-up outcome signal |
| `decision_hit_rate` | Percent of recalled results that are decision memories and then reused successfully | Need recall-result attribution and follow-up outcome signal |
| `cross_project_reuse` | Memories reused outside the project they were first created in | Need project-level recall attribution per memory access |
| `repeat_session_retention` | Users or projects with 2+ meaningful sessions in a week | Need session-level usage summaries tied to user/project identity |

## Canonical Definitions

### First Value

First value happens when all of the following are true:

- the intended setup surface is configured
- the runtime is healthy enough to use
- the user completes one `store -> recall -> session-start` loop
- the user or operator marks at least one returned memory as useful

### Reuse

Reuse means a previously stored memory helps a later session. The memory does not need to be perfect; it needs to prevent repeated explanation, repeated debugging, or repeated setup work.

### High-Value Memory

A high-value memory is one that is:

- reused multiple times
- clearly tied to a real outcome such as avoiding a bug or speeding up setup
- specific enough that another agent or user can apply it without guesswork

## Output Shape

The first shared contract should look like this conceptually:

```json
{
  "generated_at": "2026-04-13T00:00:00.000Z",
  "window": "7d",
  "activation": {
    "setup_surface_coverage": {
      "codex": "configured",
      "claude": "missing",
      "cursor": "partial"
    },
    "runtime_readiness": "pass"
  },
  "reuse": {
    "top_reused_memories": [],
    "new_memories_this_week": 0
  },
  "memory_quality": {
    "memory_mix": {}
  },
  "expansion": {
    "active_projects": 0
  }
}
```

## Phase 4 Delivery Order

1. Define the model and canonical names
2. Map current repository data into the MVP metrics
3. Expose the shared JSON payload for CLI and dashboard reuse
4. Add `vega impact`
5. Add `vega weekly`
6. Add dashboard cards and weekly feedback loop outputs

## Guardrails

- Do not present lifetime activity as if it were weekly reuse unless the label says so
- Do not mix environment health failures with product-value failures without separating them visually
- Do not call a stored memory "impact" if there is no later-session reuse signal
- When a metric is estimated or incomplete, label it clearly instead of hiding the limitation
