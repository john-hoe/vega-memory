Task: Fix all P2 bugs + supplementary test gaps from Phase 2 review.

Read AGENTS.md for rules. Read ALL relevant source files before making changes.

## P2-1: diagnose missing handoff_prompt/can_auto_fix
Files: src/core/types.ts, src/core/diagnose.ts
Fix:
- Add to DiagnoseReport type: handoff_prompt(string), can_auto_fix(boolean)
- In diagnose(): generate handoff_prompt — a markdown summary an engineer can paste into a new session to continue debugging. Include: issue description, system state, suggested next steps.
- Set can_auto_fix=true if all issues are auto-fixable (null embeddings, stale backups). Set false if integrity check fails or disk issues.
- Collect last 50 entries from performance_log
- Collect system info: Node version, OS, db path, config summary

## P2-2: Scheduler timing not spec-compliant
Files: src/scheduler/index.ts
Fix:
- Weekly task should run on Sunday at 03:00, not at daemon start time
- Implement: check current day/hour on each interval tick. If Sunday AND hour=3 AND not already run this week → run weekly tasks
- Track lastWeeklyRun timestamp to avoid duplicate runs
- Daily task should run at a fixed hour (e.g., 04:00) instead of every 24h from start
- Warning delivery: collect warnings during the day, send as digest at end of day (or on next daily run). For now, keep immediate sending but add a TODO comment about future daily digest.
- Add alert clearing: after dailyMaintenance succeeds with no errors, call notificationManager.clearAlert()

## P2-3: benchmark is too thin
Files: src/cli/commands/benchmark.ts
Fix:
- write suite: increase to 1000 memories, measure total time + avg per op
- recall suite: run 50 queries at 3 different db sizes (100/500/1000), measure avg latency
- concurrent suite: run MCP store + CLI store simultaneously, verify no SQLite locking errors
- Add --report flag: output results as markdown to data/reports/benchmark-YYYY-MM-DD.md
- Add --suite option: all|write|recall|concurrent (default: all)

## P2-4: Placeholders need more substance
Files: src/db/cloud-backup.ts, src/db/crdt.ts, src/search/sqlite-vec.ts
Fix cloud-backup.ts:
- Keep local-sync provider as primary
- Add proper error handling and logging
- Add listBackups with date sorting
- Add metadata file alongside each backup (timestamp, memory count, db size)

Fix crdt.ts:
- Integrate CRDTMerger into SyncManager.syncPending() — after syncing pending ops, merge local cache with server state
- Add field-level merge for concurrent updates to same memory (merge tags, keep longer content, higher importance wins)

Fix sqlite-vec.ts:
- Improve isAvailable() to cache the result
- Add createIndex() method that builds vector index from all existing embeddings
- Add logging when auto-upgrade happens
- Track slow query count in SearchEngine, log suggestion after 10 consecutive >300ms queries

## P2-5: memory_health too thin
Files: src/mcp/server.ts, src/api/routes.ts
Fix: Expand memory_health response to include:
- status: 'healthy' | 'degraded' | 'unhealthy'
- ollama: boolean
- db_integrity: run PRAGMA integrity_check, return boolean
- memories: total count
- latency_avg_ms: average from last 100 performance_log entries
- db_size_mb: size in MB (not bytes)
- last_backup: ISO timestamp of most recent backup file, or null
- issues: string[] of detected problems
- fix_suggestions: string[] of recommended actions
Update both MCP tool handler and API route.

## Supplementary: Test coverage gaps

### Remote/client tests
File: src/tests/sync.test.ts (add more tests)
- Test: offline sessionStart reads preferences from cache
- Test: offline store writes to cache AND queues for sync
- Test: wrong API key returns error (not empty result)
- Test: SyncManager.syncPending replays queued ops to server

### Insights tests
File: src/tests/insights.test.ts (add more tests)
- Test: detectRepeatOffenders finds tags across multiple sessions
- Test: detectDecisionPatterns groups decisions by shared tags
- Test: InsightGenerator runs through scheduler weekly task

### Diagnose/notify tests
File: src/tests/diagnose.test.ts (add more tests)
- Test: diagnose report includes handoff_prompt
- Test: diagnose report includes can_auto_fix=true when only null embeddings

File: src/tests/notify.test.ts (add more tests)
- Test: NotificationManager clears alert after successful maintenance

## After all fixes:
  npx tsc
  node --test dist/tests/*.test.js

Then commit:
  git add -A && git commit -m "fix: P2 diagnose/scheduler/benchmark/health + test coverage gaps"
  git push origin main
