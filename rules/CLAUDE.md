# Vega Memory System — Claude Code Rules

## Memory System — MANDATORY (do NOT skip, do NOT wait for user reminder)

You have access to Vega Memory via CLI. You MUST proactively store memories as events happen.

### Session lifecycle
- Session start: `vega session-start --dir $(pwd) --json` — parse output as context
- Session end: `vega session-end --project <project> --summary "<summary>"`

### Store memories immediately when events happen
- Task completed: `vega store "<content>" --type task_state --project <project> --title "<title>"`
- Decision made: `vega store "<content>" --type decision --project <project> --title "<title>"`
- Bug fixed: `vega store "<content>" --type pitfall --project <project> --title "<title>"`
- New preference: `vega store "<content>" --type preference --project <project> --title "<title>"`
- User says "记住/remember": `vega store "<content>" --type preference --project <project> --title "<title>"`

### Rules
- Store AS events happen, not at end of session — do NOT wait for user to ask
- Each distinct fact = one separate memory entry, do NOT batch into one
- Preserve specific details: error messages, file paths, commands, version numbers
- Do NOT store: emotional complaints, failed debug attempts, one-time queries, raw data, common knowledge, inconclusive exploration, meta-discussion
