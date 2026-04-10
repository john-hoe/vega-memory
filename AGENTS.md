# Vega Memory System — Agent Rules

## Project Rules
- Use TypeScript strict mode
- Use better-sqlite3-multiple-ciphers for SQLite (not better-sqlite3, not sql.js, not knex)
- Use @modelcontextprotocol/sdk for MCP
- Use commander.js for CLI
- Use native fetch for Ollama HTTP API (localhost:11434)
- Run tests after each task
- Do NOT add unnecessary comments — code should be self-documenting
- Keep files focused: one concern per file
- Use ES modules (type: "module" in package.json)

## Memory System — MANDATORY

All AI agents (Cursor, Claude Code, Codex, OpenClaw) MUST proactively store memories WITHOUT waiting for user reminder.

### Triggers (store immediately when event happens)
| Event | Type | Example |
|-------|------|---------|
| Task completed | task_state | "Implemented wiki search API endpoint" |
| Decision made | decision | "Chose FTS5 over trigram for wiki search" |
| Bug fixed | pitfall | "Dashboard breaks after tsc because static assets not copied" |
| New preference | preference | "Always use --dangerously-bypass-approvals-and-sandbox for Codex" |
| Important context | project_context | "Wiki pages are derived views, memories are source of truth" |

### Rules
- Store AS events happen, not at end of session
- Each distinct fact = one separate memory entry
- Preserve specifics: error messages, file paths, commands, version numbers
- Do NOT store: emotional complaints, failed debug attempts, one-time queries, raw data, common knowledge
- Do NOT wait for user to say "store this" — this is automatic

## VM2 Recall Protocol Integration

Treat Vega Memory as a two-stage adapter protocol:

1. `session_start(mode)` loads the bounded preload bundle.
2. `recall(query)` fetches task-specific hot memories.
3. `deep_recall(request)` is reserved for archived/original evidence.
4. `session_end(...)` closes the current work unit or handoff.

### Codex Mode Selection
- `L0`: Quick follow-up turns with strong local code context where only preferences/identity reminders are needed.
- `L1`: Default daily coding mode for implementation, bugfixes, and short edit/test loops.
- `L2`: Planning, architecture, repo-wide cleanup, ambiguous work, or new repo areas.
- `L3`: Audit, provenance, evidence collection, or original-text verification turns.
- `light` is the `L1` alias. `standard` is the `L2` alias.

### Codex Workflow
- Start each work unit with `vega session-start --dir "$(pwd)" --mode <L0|L1|L2|L3> --json`.
- Use `vega recall ...` when a task-specific fact is missing instead of widening preload by default.
- Use `deep_recall` only for cold evidence or archived/original text, or use `L3` when the preload itself must include evidence.
- Call `vega session-end --project <project> --summary "<summary>"` when the user-visible task is complete or when a durable handoff summary exists.

### Hermes Orchestration Reservation
- `L0`: Routing, dispatch, status checks, and fast orchestration turns.
- `L1`: Single-lane execution turns where Hermes already knows the local working set.
- `L2`: Multi-step synthesis, planning, architecture, or cross-lane coordination turns.
- `L3`: Audit packets, provenance review, or cold-evidence expansion.
- Trigger `session_end` as soon as Hermes emits a delegation handoff packet or durable turn summary that another agent will consume. Do not wait for the entire multi-agent workflow to finish if the current orchestrator turn has ended.

## Long Audit / Review Discipline

For full-repo audits, large-scope reviews, or tasks that consolidate findings into a GitHub issue:

- Do NOT treat issue creation, issue comment updates, finishing one module, or finding one batch of issues as completion.
- Treat the task as complete only when the requested scope has been audited end-to-end and confirmed findings have been consolidated into the same repair backlog.
- If forced to pause because of context limits, tool failures, or external blockers, leave a resume packet with completion percentage, completed scope, remaining scope, and the exact next module or file to continue from.
