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
