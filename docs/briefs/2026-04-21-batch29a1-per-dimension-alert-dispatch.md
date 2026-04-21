# Batch 29a.1 — Close B8 review: per-dimension alert dispatch + cron parser widening

## Context

B8 review of `a3fd25c` returned BLOCK with 1 HIGH + 1 MED + 1 LOW:

- **HIGH**: `dispatchReconciliationAlerts()` calls `NotificationManager.notifyWarning/Error` per alert, but notify-manager's downstream semantics aggregate: warnings go into a single `Daily Warning Digest`; errors overwrite the same `active-alert.md`. Multiple dimensions going critical simultaneously → only the last critical is visible in file channel. Brief required "per-dimension 各自独立 alert / 不是一条合并" end-to-end.
- **MEDIUM**: `VEGA_RECONCILIATION_SCHEDULE_CRON` parser only accepts `*` or integer literals; common `*/15`, `1,15`, `1-5` silently rejected.
- **LOW**: Tests don't use mock NotificationManager, so HIGH issue slipped through green.

Fix HIGH by adding `src/reconciliation/alert-dispatcher.ts` that writes per-dimension alert files directly (bypassing the aggregating digest path). Telegram / NotificationManager path still runs for summary notification (human readable aggregation is OK there). Fix MED by widening cron parser to accept `*/N`. Fix LOW by adding mock test.

No amend — new commit on HEAD (parent = `a3fd25c`).

## Scope

### 1. New file `src/reconciliation/alert-dispatcher.ts`

```ts
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ReconciliationAlert } from "./alert.js";

export interface AlertDispatcher {
  dispatch(alerts: ReadonlyArray<ReconciliationAlert>, now: Date): Promise<void>;
}

export function createPerDimensionAlertDispatcher(baseDir: string): AlertDispatcher {
  return {
    async dispatch(alerts, now) {
      if (alerts.length === 0) return;
      mkdirSync(baseDir, { recursive: true });
      for (const alert of alerts) {
        const filename = `reconciliation-${alert.dimension}-${alert.severity}.md`;
        const content = renderAlertMarkdown(alert, now);
        writeFileSync(join(baseDir, filename), content);
      }
    }
  };
}

function renderAlertMarkdown(alert: ReconciliationAlert, now: Date): string {
  return [
    `# Reconciliation Alert: ${alert.dimension}`,
    ``,
    `**Severity**: ${alert.severity.toUpperCase()}`,
    `**Mismatch rate**: ${(alert.mismatch_rate * 100).toFixed(2)}%`,
    `**Threshold exceeded**: ${(alert.threshold_exceeded * 100).toFixed(2)}%`,
    `**Issued at**: ${now.toISOString()}`,
    ``,
    alert.summary
  ].join("\n");
}
```

Per-dimension filename ensures multi-dim concurrent alerts each get their own file, not overwriting.

### 2. `src/scheduler/tasks.ts` — wire alert-dispatcher into dailyMaintenance

Where `dispatchReconciliationAlerts` currently calls NotificationManager per-alert, replace with:

```ts
import { createPerDimensionAlertDispatcher } from "../reconciliation/alert-dispatcher.js";

// Inside dailyMaintenance (after evaluateReconciliationAlerts):
const alertBaseDir = join(config.dataDir, "alerts", "reconciliation");
const dispatcher = options.alertDispatcher ?? createPerDimensionAlertDispatcher(alertBaseDir);
await dispatcher.dispatch(alerts, now);

// Keep the NotificationManager digest path for telegram / summary aggregation:
if (notificationManager && alerts.length > 0) {
  const summary = `Reconciliation found ${alerts.length} alert(s) across dimensions: ${[...new Set(alerts.map(a => a.dimension))].join(", ")}`;
  notificationManager.notifyWarning(summary);  // goes into daily digest; OK as summary
}
```

DI seam: `options.alertDispatcher?: AlertDispatcher` for test injection.

### 3. `src/scheduler/tasks.ts` — widen cron parser

Where `VEGA_RECONCILIATION_SCHEDULE_CRON` is parsed, accept:
- `*` (always match)
- `N` (exact integer)
- `*/N` (every N units)
- `N,M,K` (comma list)
- `N-M` (range)

Implementation: small field-parser helper:
```ts
function matchCronField(fieldSpec: string, currentValue: number, max: number): boolean {
  if (fieldSpec === "*") return true;
  for (const part of fieldSpec.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "*") return true;
    // */N
    const stepMatch = trimmed.match(/^\*\/(\d+)$/);
    if (stepMatch) {
      const step = Number(stepMatch[1]);
      if (step > 0 && currentValue % step === 0) return true;
      continue;
    }
    // N-M range
    const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const [, lo, hi] = rangeMatch;
      const lowN = Number(lo), highN = Number(hi);
      if (lowN <= currentValue && currentValue <= highN) return true;
      continue;
    }
    // Plain integer
    const num = Number(trimmed);
    if (!Number.isNaN(num) && num === currentValue) return true;
  }
  return false;
}
```

Apply to each field (minute, hour, day, month, weekday) of the 5-field cron spec. If any field fails, skip. If all pass, run.

### 4. Update `src/tests/reconciliation-alerts.test.ts` — add per-dim dispatcher + mock test

Add 2 new test cases (bringing total to 8):

1. **Per-dim dispatcher writes N files for N alerts**: call dispatcher.dispatch with 3 alerts for 3 different dimensions; assert 3 distinct files exist in the target dir.
2. **Mock NotificationManager receives exactly 1 summary call per run, not per alert**: inject a mock manager; run dispatcher + summary; assert `notifyWarning` was called exactly once (summary, not per-alert spam).

### 5. Update `src/tests/reconciliation-auto-trigger.test.ts` — add cron extended syntax test

Add 1 test:
- `VEGA_RECONCILIATION_SCHEDULE_CRON="*/15 * * * *"` → run when current minute % 15 === 0; skip otherwise. Test via two `now()` values: one at minute 15 (should run), one at minute 7 (should skip).

Alternatively merge into existing auto-trigger test suite. Total tests in this file go from 3 → 4.

## Out of scope — do NOT touch

- `src/notify/**` (sealed; we're adding a parallel path, not modifying)
- `src/reconciliation/{alert,findings-store,orchestrator,etc}.ts` (B8 sealed alert.ts; only add new alert-dispatcher.ts)
- `src/monitoring/**`, `src/backup/**`, `.eslintrc.cjs`, `package.json`, `src/feature-flags/**`, `src/sdk/**`, `src/promotion/**`, `src/db/**`, `src/wiki/**`, `src/core/contracts/**`, `src/retrieval/**`, `src/api/**`, `src/mcp/**`, `src/index.ts`
- `src/sunset/**`, `src/alert/**`, `src/timeout/**`, `src/checkpoint/**`

Allowed:
- `src/scheduler/tasks.ts` (wiring + cron parser widening)
- `src/reconciliation/alert-dispatcher.ts` (new file)
- `src/tests/reconciliation-alerts.test.ts` (add 2 cases)
- `src/tests/reconciliation-auto-trigger.test.ts` (add 1 case)

## Forbidden patterns

- NO amend of prior commits — new commit on HEAD (parent = `a3fd25c`)
- `createPerDimensionAlertDispatcher` MUST NOT modify notify/**; it's parallel, not replacement
- NotificationManager still used for telegram / summary (not ripped out)
- Cron parser widening MUST NOT introduce a new library dep (implement inline)
- Per-dim alert files MUST have unique paths (not overwriting)
- Tests MUST inject mock dispatcher / NotificationManager (not real I/O)

## Acceptance criteria

1. `src/reconciliation/alert-dispatcher.ts` exists with `createPerDimensionAlertDispatcher` export
2. `rg -n "alert-dispatcher|AlertDispatcher" src/scheduler/tasks.ts` ≥ 1
3. `rg -n "\\*/" src/scheduler/tasks.ts` ≥ 1 (cron `*/N` widening)
4. `rg -c "^test\\(" src/tests/reconciliation-alerts.test.ts` ≥ 8 (was 6 in B8; +2)
5. `rg -c "^test\\(" src/tests/reconciliation-auto-trigger.test.ts` ≥ 4 (was 3 in B8; +1)
6. `git diff HEAD --name-only` ⊆ `{src/scheduler/tasks.ts, src/reconciliation/alert-dispatcher.ts, src/tests/reconciliation-alerts.test.ts, src/tests/reconciliation-auto-trigger.test.ts, docs/briefs/2026-04-21-batch29a1-per-dimension-alert-dispatch.md}`
7. `set -o pipefail; npm run build` exits 0; `set -o pipefail; npm test` ≥ 1253 pass / 0 fail (1250 + 3 new)
8. `npm run lint:readonly-guard` exits 0
9. Not-amend; parent of new commit = `a3fd25c`
10. Commit title prefix `fix(reconciliation):`
11. Commit body:
    ```
    Close B8 review: per-dimension alert dispatch + cron parser widening.

    HIGH fix — per-dimension alert channel:
    - New src/reconciliation/alert-dispatcher.ts: writes one alert file
      per (dimension, severity) tuple to <dataDir>/alerts/reconciliation/,
      so concurrent multi-dim alerts each survive distinctly instead of
      overwriting active-alert.md.
    - src/scheduler/tasks.ts: wires the dispatcher (DI seam for tests);
      keeps NotificationManager for single summary notification
      (telegram-friendly; digest aggregation acceptable for humans).

    MEDIUM fix — cron parser widening:
    - src/scheduler/tasks.ts: VEGA_RECONCILIATION_SCHEDULE_CRON parser
      now accepts */N steps, N-M ranges, and N,M,K comma lists in addition
      to literal integers and *. No external library added.

    LOW fix — regression tests with mock manager:
    - src/tests/reconciliation-alerts.test.ts: +2 cases (per-dim
      file dispatch; mock NotificationManager receives single summary
      not N spams).
    - src/tests/reconciliation-auto-trigger.test.ts: +1 case (*/15 cron
      runs at minute 15 and skips at minute 7).

    Scope: src/scheduler/tasks.ts + new alert-dispatcher.ts + 2 existing
    tests. Zero touches to notify internals (14a sealed).

    Scope-risk: low (new parallel file channel; old channel retained for
    telegram summary)
    Reversibility: clean
    ```

## Review checklist

- Per-dim files written to unique paths (no overwriting)?
- NotificationManager called ONCE per run (summary, not per-alert)?
- Cron parser handles `*/15`, `1,15`, `1-5` without throwing?
- Mock NotificationManager test injection works?
- Scope strictly limited to the 4 files + brief?
- New commit stacks on `a3fd25c` (not amend)?
- `npm test` ≥ 1253?

## Commit discipline

- Single atomic commit
- Prefix `fix(reconciliation):`
- Body per Acceptance #11
