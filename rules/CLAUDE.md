Rules for Claude Code to use vega CLI:
- On session start: run `vega session-start --dir $(pwd) --json`
- Parse JSON output and use as context
- On task complete: run `vega store "..." --type task_state`
- On error solved: run `vega store "..." --type pitfall`
- On session end: run `vega session-end --project <p> --summary "..."`
