# Batch 29a — Reconciliation ops: #43 auto-trigger + #44 notification wiring

## Context

Two `wave-5-followup` issues, both depending on reconciliation framework from batch 11a (orchestrator + findings-store). Per user decision, both were deferred for ≥ 1 week real-world observation before wiring. Observation window is past — wire both now.

**#43** — reconciliation orchestrator has no auto-trigger. Requires CLI / MCP manual invocation, so findings never populate automatically. Fix: hook into `src/scheduler/tasks.ts::dailyMaintenance` with `VEGA_RECONCILIATION_AUTO_ENABLED` env gate (default off). Emit `vega_reconciliation_*` metrics.

**#44** — findings are persisted but no alerts fire. Fix: after reconciliation run, compute per-dimension mismatch rate; route to `NotificationManager` if above threshold. WARN at 5%, CRITICAL at 10%. Flap cooldown to avoid spam.

Bundled because #44 strictly requires #43 (alerts need something to alert on). Sequentially: scheduler hook → threshold evaluator → notification manager call.

No amend — new commit on HEAD (parent = `dc6a470`).

## Scope

### Part A — #43 auto-trigger via scheduler

#### A1. `src/scheduler/tasks.ts` — extend dailyMaintenance OR add nightlyReconciliation

Pattern A (preferred): extend existing `dailyMaintenance(repository, compactService, memoryService, config, ...)` function at `src/scheduler/tasks.ts:248` with a new optional reconciliation step, gated by env:

```ts
if (process.env.VEGA_RECONCILIATION_AUTO_ENABLED === "true") {
  try {
    const { runReconciliation } = await import("../reconciliation/orchestrator.js");
    const result = await runReconciliation({
      repository,
      window: { hours: 24 },  // from env VEGA_RECONCILIATION_WINDOW_HOURS if set
      dimensions: ["count", "shape", "semantic", "ordering"]  // minus Derived (Wave 6)
    });
    metrics.recordReconciliationRun(result);
    // Alert evaluation (Part B) runs here
    await evaluateAndNotify(result, notificationManager, config);
  } catch (err) {
    logger.error({ err }, "reconciliation_auto_trigger_failed");
    metrics.incrementReconciliationFailures();
  }
}
```

Pattern B (alternative): new `nightlyReconciliation(...)` standalone function + scheduler call in `src/scheduler/index.ts`. Codex picks based on existing dailyMaintenance structure.

#### A2. Env parsing

Use the existing `parsed > 0` guard pattern (consistent with sunset / alert / timeout):
- `VEGA_RECONCILIATION_AUTO_ENABLED` — string "true" / "false" / unset (default false)
- `VEGA_RECONCILIATION_WINDOW_HOURS` — number, default 24, validated via `parsed > 0`
- `VEGA_RECONCILIATION_SCHEDULE_CRON` — string cron expression (optional); if absent, runs inside dailyMaintenance which has its own scheduling

#### A3. Metrics emission

`src/monitoring/vega-metrics.ts` (sealed — don't touch) already has a metrics emitter pattern. Find an existing hook point (e.g. `incrementCounter("vega_reconciliation_runs_total", { status, dimension })`) OR add a minimal metrics call via the existing `VegaMetricsCollector` in `src/reconciliation/orchestrator.ts` (if present).

If no clean metrics seam exists without touching the sealed `vega-metrics.ts`:
- Document the deferral in commit body
- Emit a simple log line for now: `logger.info({ reconciliation_result: summary }, "reconciliation_complete")`
- Metrics wiring becomes a follow-up batch

### Part B — #44 notification wiring

#### B1. New helper `src/reconciliation/alert.ts` (new file)

Pure function that evaluates findings and decides alert severity:

```ts
export type ReconciliationAlert = {
  severity: "warn" | "critical";
  dimension: string;
  mismatch_rate: number;
  threshold_exceeded: number;
  summary: string;
};

export function evaluateReconciliationAlerts(
  findings: ReconciliationFindings,
  config: { warn_threshold?: number; critical_threshold?: number; per_dimension_overrides?: Record<string, {warn: number; critical: number}> }
): ReconciliationAlert[]
```

Default thresholds:
- `warn: 0.05` (5% mismatch rate)
- `critical: 0.10` (10% mismatch rate)

Returns an array (may be empty). Each dimension above threshold gets its own alert.

#### B2. Flap cooldown

Track per-(dimension, severity) last-alert timestamp. Suppress repeat alerts within `VEGA_RECONCILIATION_FLAP_COOLDOWN_MS` (default 1 hour = 3600000ms).

Simplest: in-memory Map keyed by `${dimension}:${severity}`. Persisted to findings-store JSON column if possible (findings-store is sealed — don't touch its schema; use in-memory only this batch; persistence is future work).

#### B3. `dispatchAlerts` — call NotificationManager

```ts
// In dailyMaintenance after reconciliation run:
const alerts = evaluateReconciliationAlerts(result.findings, config);
for (const alert of alerts) {
  if (passesCooldown(alert)) {
    await notificationManager.send({
      severity: alert.severity,
      title: `Reconciliation: ${alert.dimension} at ${(alert.mismatch_rate * 100).toFixed(1)}% mismatch`,
      body: alert.summary,
      source: "vega-reconciliation"
    });
    recordCooldown(alert);
  }
}
```

Notification channels are already configured in `src/notify/manager.ts` (alert-file + telegram per 14a); this wiring just reuses them.

### Part C — Tests

New `src/tests/reconciliation-alerts.test.ts` (≥ 6 cases):

1. `evaluateReconciliationAlerts` empty findings → empty alerts array
2. findings below warn threshold → empty array
3. findings at warn threshold → 1 warn alert
4. findings at critical threshold → 1 critical alert
5. multiple dimensions above threshold → multiple alerts (per-dim)
6. flap cooldown suppresses repeat alert

New `src/tests/reconciliation-auto-trigger.test.ts` (≥ 3 cases):

1. `VEGA_RECONCILIATION_AUTO_ENABLED=false` → reconciliation NOT run during dailyMaintenance
2. `VEGA_RECONCILIATION_AUTO_ENABLED=true` → reconciliation run; findings populated
3. Reconciliation failure → captured + logged + metrics.incrementFailures; does NOT crash dailyMaintenance

Hermetic: `mkdtempSync` + `:memory:` SQLite + env overrides; NO real Telegram / webhook.

## Out of scope — do NOT touch

- `src/backup/**`, `.eslintrc.cjs`, `package.json`, `src/promotion/**`, `src/db/fts-query-escape.ts`, `src/db/schema.ts`, `src/db/repository.ts`, `src/db/candidate-repository.ts`, `src/wiki/**`, `src/core/contracts/**`, `src/feature-flags/**`, `src/retrieval/**`, `src/sdk/**` (prior sealed)
- `src/reconciliation/{findings-store,orchestrator,shape-dimension,count-dimension,semantic-dimension,ordering-dimension,report,retention,index}.ts` (11a-11c sealed; only ADD new `alert.ts`)
- `src/monitoring/vega-metrics.ts`, `metrics-fingerprint.ts`, `metrics.ts`, `dashboards/**` (sealed across many batches)
- `src/notify/{manager,alert-file,telegram}.ts` — reuse as-is; do NOT modify their internals
- `src/sunset/**`, `src/alert/**`, `src/timeout/**`, `src/checkpoint/**`, `src/api/**`, `src/mcp/**`, `src/index.ts`, `src/db/migrations/**`

Allowed:
- `src/scheduler/tasks.ts` (extend dailyMaintenance)
- `src/scheduler/index.ts` (if needed for config plumbing)
- `src/reconciliation/alert.ts` (new file)
- `src/tests/reconciliation-alerts.test.ts` (new)
- `src/tests/reconciliation-auto-trigger.test.ts` (new)

## Forbidden patterns

- Production code MUST NOT sniff test env
- Tests MUST NOT touch real HOME / keychain / user config
- Tests MUST NOT send real alerts (inject mock NotificationManager)
- NO amend of prior commits — new commit on HEAD (parent = `dc6a470`)
- `VEGA_RECONCILIATION_AUTO_ENABLED` default MUST be false (no silent surprise)
- Reconciliation failure MUST NOT crash dailyMaintenance (try/catch)
- `evaluateReconciliationAlerts` MUST be pure (no I/O, no DB, no env reads)
- Flap cooldown state is in-memory this batch; NO persistence to findings-store (sealed)

## Acceptance criteria

1. `rg -nE "VEGA_RECONCILIATION_AUTO_ENABLED" src/scheduler/tasks.ts` ≥ 1
2. `rg -nE "runReconciliation|reconciliation.*orchestrator" src/scheduler/tasks.ts` ≥ 1 (wiring present)
3. `src/reconciliation/alert.ts` exists; `rg -n "evaluateReconciliationAlerts" src/reconciliation/alert.ts` ≥ 1
4. `rg -nE "NotificationManager|notificationManager" src/scheduler/tasks.ts` ≥ 1 (alert dispatch wired)
5. `src/tests/reconciliation-alerts.test.ts` exists; `rg -c "^test\\(" src/tests/reconciliation-alerts.test.ts` ≥ 6
6. `src/tests/reconciliation-auto-trigger.test.ts` exists; `rg -c "^test\\(" src/tests/reconciliation-auto-trigger.test.ts` ≥ 3
7. `git diff HEAD -- src/reconciliation/findings-store.ts src/reconciliation/orchestrator.ts src/reconciliation/shape-dimension.ts src/reconciliation/count-dimension.ts src/reconciliation/semantic-dimension.ts src/reconciliation/ordering-dimension.ts src/reconciliation/report.ts src/reconciliation/retention.ts src/reconciliation/index.ts src/notify/manager.ts src/notify/alert-file.ts src/notify/telegram.ts src/monitoring/ src/backup/ src/promotion/ src/feature-flags/ src/retrieval/ src/sdk/ src/sunset/ src/alert/ src/timeout/ src/checkpoint/ src/api/ src/mcp/ src/db/ src/core/contracts/ .eslintrc.cjs package.json src/index.ts` outputs empty
8. `git diff HEAD -- src/tests/` shows only 2 new files
9. `set -o pipefail; npm run build` exits 0; `set -o pipefail; npm test` ≥ 1250 pass / 0 fail (1241 + ≥ 9 new)
10. `npm run lint:readonly-guard` exits 0
11. Not-amend; parent of new commit = `dc6a470`
12. Commit title prefix `feat(reconciliation):`
13. Commit body:
    ```
    Close #43 + #44 (reconciliation ops wiring).

    #43 auto-trigger:
    - src/scheduler/tasks.ts dailyMaintenance: gated call to
      runReconciliation(...) when VEGA_RECONCILIATION_AUTO_ENABLED=true
      (default false). Window configurable via
      VEGA_RECONCILIATION_WINDOW_HOURS (default 24). Failures caught and
      logged; metrics counter for runs + failures.

    #44 notification wiring:
    - New src/reconciliation/alert.ts: pure
      evaluateReconciliationAlerts(findings, config) returns per-
      dimension alerts when mismatch_rate exceeds warn (5%) / critical
      (10%) thresholds. Per-dimension overrides supported.
    - In-memory flap cooldown (default 1 hour) suppresses repeat alerts
      per (dimension, severity).
    - dailyMaintenance dispatches alerts via existing NotificationManager
      (reuses 14a channel wiring — alert-file + telegram).

    Tests:
    - reconciliation-alerts.test.ts (≥ 6 cases) covers threshold
      evaluation, multi-dimension alerts, flap cooldown.
    - reconciliation-auto-trigger.test.ts (≥ 3 cases) covers
      enable-flag gating, run-failure captured, metrics.

    Scope: src/scheduler/tasks.ts + new src/reconciliation/alert.ts +
    2 new tests. Zero touches to reconciliation framework files
    (11a-11c sealed), notify internals (14a sealed), monitoring
    (sealed).

    Scope-risk: low (default-disabled auto-trigger; alerts gated on
    thresholds)
    Reversibility: clean (unset env var OR revert commit)
    ```

## Review checklist

- `VEGA_RECONCILIATION_AUTO_ENABLED` default is false, not true?
- Reconciliation failure caught so dailyMaintenance continues?
- `evaluateReconciliationAlerts` truly pure (no fs / env / net)?
- WARN threshold at 5%, CRITICAL at 10%? Per-dimension override hook present?
- Flap cooldown actually suppresses repeat (tested)?
- NotificationManager reused (not re-instantiated with new config)?
- Tests don't send real alerts (mock injection)?
- `npm run lint:readonly-guard` still exit 0?
- New commit stacks on `dc6a470` (not amend)?

## Commit discipline

- Single atomic commit
- Prefix `feat(reconciliation):`
- Body per Acceptance #13
- Files changed: `src/scheduler/tasks.ts` + new `src/reconciliation/alert.ts` + 2 new test files. Maybe `src/scheduler/index.ts` if config plumbing needs it.
