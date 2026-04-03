Task: Fix remaining P1/P2 bugs from second code review.

Read AGENTS.md for rules. Read src/db/backup.ts, src/db/repository.ts, src/core/session.ts before making changes.

## P1: Backup not concurrency-safe under WAL mode
File: src/db/backup.ts
Problem: Current approach uses PRAGMA wal_checkpoint + copyFileSync. During concurrent writes from scheduler/MCP/CLI, the backup may miss recent commits.
Fix: Use better-sqlite3's built-in `backup()` API which provides a proper online backup with consistent snapshot semantics. Replace the current copyFileSync approach:

```typescript
import Database from "better-sqlite3";

export function createBackup(dbPath: string, backupDir: string): string {
  // Use better-sqlite3's backup API for concurrency-safe snapshots
  const date = new Date().toISOString().slice(0, 10);
  const destPath = path.join(backupDir, `memory-${date}.db`);
  mkdirSync(backupDir, { recursive: true });
  
  const sourceDb = new Database(dbPath, { readonly: true });
  try {
    sourceDb.backup(destPath);
  } finally {
    sourceDb.close();
  }
  return destPath;
}
```

This uses SQLite's online backup API internally, which guarantees a consistent snapshot even under concurrent writes.

## P2: sessionStart loads archived preferences and project_context
File: src/core/session.ts
Problem: sessionStart() queries for preferences and project_context without filtering by status='active'. Archived records leak into session context.
Fix: Add status: 'active' filter to the listMemories calls for preferences and project_context. Find the lines that load preferences and context, and add the status filter:
- preferences query: add `status: 'active'` 
- context query: add `status: 'active'`

## After fixes:

1. Add/update tests:
   - Test: backup produces consistent snapshot even with concurrent writes (open db, write, backup, write again, verify backup has first write but backup is independently readable)
   - Test: sessionStart does NOT include archived preferences
   - Test: sessionStart does NOT include archived project_context

2. Run: npx tsc && node --test dist/tests/*.test.js

3. Commit: git add -A && git commit -m "fix: backup concurrency safety via SQLite backup API + session archived filter"

4. Push: git push origin main
