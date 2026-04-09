# Vega Memory System — Claude Code Rules

## Memory System — MANDATORY (do NOT skip, do NOT wait for user reminder)

You have access to Vega Memory via CLI and, when your Claude host wires the MCP server, MCP tools. Treat Vega Memory as a two-stage protocol:

1. `session_start(mode)` loads the bounded preload bundle.
2. `recall(query)` fetches task-specific hot memories on demand.
3. `deep_recall(request)` is only for cold evidence, provenance, and original text.
4. `session_end(...)` closes the work unit and persists durable extraction.

Do not widen preload by default. Start with the smallest mode that fits the turn, then call `recall` when you need more.

## Claude Code Mode Selection

- `L0`: Fast follow-up turns when Claude Code already has the local file context and only needs identity/preference reminders.
- `L1`: Default daily coding mode for routine implementation, small bugfixes, short follow-ups, and most edit/test loops.
- `L2`: Planning, architecture review, broad refactors, ambiguous tasks, or repo areas Claude Code has not touched yet.
- `L3`: Audit, evidence, provenance, or original-text turns where the preload itself should include archive-backed `deep_recall` results.
- `light`: Backward-compatible alias for `L1`.
- `standard`: Backward-compatible alias for `L2`.

## Session Lifecycle

- Session start: `vega session-start --dir "$(pwd)" --mode L1 --json`
- If you are entering a new repo area or doing planning: `vega session-start --dir "$(pwd)" --mode L2 --json`
- If you only need a minimal follow-up preload: `vega session-start --dir "$(pwd)" --mode L0 --json`
- If the turn is evidence-heavy: `vega session-start --dir "$(pwd)" --mode L3 --json`
- Stage-two hot retrieval: `vega recall "sqlite backup checklist" --project <project> --limit 5 --min-similarity 0.3 --json`
- Session end: `vega session-end --project <project> --summary "<summary>"`

Use `recall` when task-specific facts are missing. Do not jump from `L1` to `L2` just because one targeted memory is missing.

## Store Memories Immediately When Events Happen

- Task completed: `vega store "<content>" --type task_state --project <project> --title "<title>"`
- Decision made: `vega store "<content>" --type decision --project <project> --title "<title>"`
- Bug fixed: `vega store "<content>" --type pitfall --project <project> --title "<title>"`
- New preference: `vega store "<content>" --type preference --project <project> --title "<title>"`
- User says "记住/remember": `vega store "<content>" --type preference --project <project> --title "<title>"`
- Important durable repo context discovered: `vega store "<content>" --type project_context --project <project> --title "<title>"`

## `deep_recall` Example

Use `deep_recall` only when Claude Code needs archived/original evidence, provenance, or audit material that should not be injected by default.

Example MCP call:

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

If the Claude host only exposes HTTP, send the same payload to `POST /api/deep-recall`. Expect a feature-disabled error when deep recall is unavailable in the current runtime.

## Rules

- Store AS events happen, not at end of session. Do NOT wait for the user to ask.
- Each distinct fact = one separate memory entry. Do NOT batch unrelated facts together.
- Preserve specific details: error messages, file paths, commands, version numbers.
- Use `L1` first for routine coding, then escalate to `L2` or `L3` only when the turn actually needs more preload or evidence.
- Call `session_end` when the user-visible task is complete or when a durable handoff summary exists.
- Do NOT store emotional complaints, failed debug attempts, one-time queries, raw data, common knowledge, inconclusive exploration, or meta-discussion.
