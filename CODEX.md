# Vega Memory System — Codex Rules

## Project Rules
- Read the task instruction FIRST before doing anything
- Follow the spec strictly
- Use TypeScript strict mode
- Use better-sqlite3-multiple-ciphers for SQLite (not better-sqlite3, not sql.js, not knex)
- Use @modelcontextprotocol/sdk for MCP
- Use commander.js for CLI
- Use native fetch for Ollama HTTP API (localhost:11434)
- Run tests after each task
- Commit after each task with the specified commit message
- Do NOT add unnecessary comments — code should be self-documenting
- Keep files focused: one concern per file
- Use ES modules (type: "module" in package.json)

## Memory System — MANDATORY (do NOT skip, do NOT wait for user reminder)

You have access to Vega Memory via MCP tools or CLI. You MUST proactively store memories as events happen, WITHOUT waiting for the user to ask.

### When MCP is available (preferred)
- Session start -> call `vega.session_start(working_directory, task_hint)`
- Task completed -> call `vega.memory_store(type: "task_state")` immediately
- Decision made -> call `vega.memory_store(type: "decision")` immediately
- Bug fixed -> call `vega.memory_store(type: "pitfall")` immediately
- New preference -> call `vega.memory_store(type: "preference")` immediately
- User says "记住/remember" -> call `vega.memory_store(source: "explicit")`
- Session ending -> call `vega.session_end(summary)`

### When using CLI (fallback)
- Session start: `vega session-start --dir $(pwd) --json`
- Store memory: `vega store "<content>" --type <type> --project <project> --title "<title>"`
- Session end: `vega session-end --project <project> --summary "<summary>"`

### What to store (structured extraction, NOT raw conversation)
Each memory should be a single, specific fact with:
- Clear title (what happened)
- Specific content (error messages, file paths, commands, version numbers — preserve details)
- Correct type: task_state | decision | pitfall | preference | project_context | insight
- Relevant tags

### What NOT to store
- Emotional complaints or frustration
- Failed debug attempts that led nowhere
- One-time queries or commands
- Raw data dumps or large code blocks
- Common programming knowledge
- Inconclusive exploration
- Meta-discussion about the conversation itself

### Critical: Automatic, not manual
- Store memories AS events happen, not at end of session
- Do NOT batch all memories into one entry
- Do NOT wait for the user to say "store this"
- Do NOT compress multiple facts into a single summary
- Each distinct fact/decision/pitfall = one separate memory entry
