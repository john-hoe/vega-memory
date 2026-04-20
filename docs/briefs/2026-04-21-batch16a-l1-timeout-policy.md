# Batch 16a — L1 Timeout Policy (P8-023.1-.5 closure)

## Context

P8-023 (Wave 5) ships L1 checkpoint TTL timeout detection with host-tier differentiated policy. Existing infra:
- L1 checkpoints persist to an existing table with `ttl_ms` / `expires_at` columns (from Wave 3 P8-021).
- `checkpoint_failures` table already exists as the sink for hard failures (from Wave 3 stack).
- Host-tier classification already resolves per-request (from Wave 4).

Design picks:
- **Module location**: New `src/timeout/` isolated directory (mirrors sunset/alert pattern — greenfield, no reach into existing `src/checkpoint/**` code).
- **Trigger**: Self-managed `setInterval` scheduler (60s default, `VEGA_TIMEOUT_SWEEP_INTERVAL_MS` env with `parsed > 0`) + MCP tool `checkpoint.timeout_sweep` for manual invocation. Mirrors 13a/14a/15a scheduler pattern.
- **T-tier policy** (from v1.1 spec):
  - T1 (user-facing / soft) → emit `presumed_sufficient` degradation event; NOT a hard failure. Continues downstream.
  - T2 (mid-trust) → same `presumed_sufficient` path.
  - T3 (hard requirement) → hard failure; insert row into `checkpoint_failures` with reason `l1_ttl_expired`.
- **Batch limit**: `max_sweep_per_run` default 100, `VEGA_TIMEOUT_SWEEP_MAX_PER_RUN` env override with `parsed > 0` guard. Prevents single sweep from thrashing DB.
- **Byte-lock on Wave 3**: Do NOT modify `src/checkpoint/**` files. Query existing tables via raw SQL through `DatabaseAdapter`. Schema evolution (if any) — defer; if existing schema doesn't expose what we need, the sweep returns `degraded: "schema_incompatible"` and we file a follow-up.

All 5 subs of P8-023 in one batch: .1 detector / .2 host-tier / .3 failure-write / .4 MCP tool / .5 tests + doc.

## Scope

### 1. `src/timeout/config.ts` (new)

Runtime config:
- `TimeoutSweepConfig = { intervalMs: number, maxPerRun: number, enabled: boolean }`
- `resolveTimeoutSweepConfig(env?: Record<string, string | undefined>): TimeoutSweepConfig`:
  - `intervalMs`: `env.VEGA_TIMEOUT_SWEEP_INTERVAL_MS` via `Number.parseInt`, accept `parsed > 0`, else default 60_000.
  - `maxPerRun`: `env.VEGA_TIMEOUT_SWEEP_MAX_PER_RUN` via `Number.parseInt`, accept `parsed > 0`, else default 100.
  - `enabled`: `env.VEGA_TIMEOUT_SWEEP_ENABLED !== "false"` (default enabled). Same pattern as VEGA_HOST_MEMORY_FILE_ENABLED.

### 2. `src/timeout/detector.ts` (new)

Core detection + policy:
- `DetectedTimeout = { checkpoint_id: string, created_at: number, ttl_ms: number, expires_at: number, host_tier: "T1" | "T2" | "T3" | "unknown", surface?: string }`
- `detectExpiredCheckpoints(db, { now, maxPerRun }): DetectedTimeout[]`:
  - Query existing `checkpoints` table (or equivalent name — codex inspects at implementation time) WHERE `expires_at < now` AND `resolved_at IS NULL` AND `status IS NOT 'expired'` ORDER BY `expires_at` ASC LIMIT `maxPerRun`.
  - Cast `host_tier` column to the enum; unknown → `"unknown"`.
  - If the expected table / columns don't exist in the current schema (e.g. Wave 3 sealed earlier without `expires_at` column), return `[]` and log warn with reason `"schema_incompatible"` — a non-throwing fallback.

### 3. `src/timeout/policy.ts` (new)

Classification layer:
- `TimeoutPolicyDecision = { decision: "presumed_sufficient" | "hard_failure", reason: string }`
- `classifyTimeout({ host_tier }: DetectedTimeout): TimeoutPolicyDecision`:
  - `T1` / `T2` → `{decision: "presumed_sufficient", reason: "l1_ttl_expired_tier_" + tier}`
  - `T3` → `{decision: "hard_failure", reason: "l1_ttl_expired_tier_t3"}`
  - `unknown` → `{decision: "hard_failure", reason: "l1_ttl_expired_tier_unknown"}` (fail-safe: unknown tier treated as T3-equivalent)

### 4. `src/timeout/recorder.ts` (new)

Failure-write and checkpoint marker:
- `recordTimeoutFailure(db, { checkpoint_id, decision, reason, detected_at })`: 
  - If `decision === "hard_failure"`: INSERT row into `checkpoint_failures` (existing table) with `checkpoint_id`, `reason`, `detected_at`, `category = "l1_ttl_expired"`. Use the existing columns of `checkpoint_failures`; if a column is missing, fallback to inserting the minimal subset (id + checkpoint_id + reason + created_at) and log a warning.
  - If `decision === "presumed_sufficient"`: do NOT insert; instead update the source checkpoint row's `status = "expired_degraded"` (if the column exists). Adding a column is out of scope; if status column doesn't accept this value, fall back to a debug log.
  - Postgres-safe: all writes guarded by `if (db.isPostgres) { ... } else { ... }` at the helper level; the SQLite branch performs the actual writes; the Postgres branch is no-op.
  - Never throws; errors → logger + return `{ written: false, reason: string }`.

### 5. `src/timeout/scheduler.ts` (new)

Self-managed lifecycle, mirror `AlertScheduler` / `SunsetScheduler`:
- `class TimeoutSweepScheduler`
  - Constructor: `{ db, config, detector, policy, recorder, now }`. Defaults wire to the module-local functions but injectable for testing.
  - `start()` — if `config.enabled`, `setInterval(() => this.tick(), config.intervalMs)`; timer `unref()`-ed.
  - `stop()` — `clearInterval`, idempotent.
  - `tick()`: `detectExpiredCheckpoints(...)` → for each: `classifyTimeout(...)` + `recordTimeoutFailure(...)`. Catches errors and swallows; never throws.

### 6. `src/timeout/mcp.ts` (new) — helper for MCP tool handler

- `sweepCheckpointTimeouts(db, { now, maxPerRun? }): Promise<{ schema_version: "1.0", swept_at: string, detected_count: number, hard_failures: number, degraded_events: number, records: Array<{checkpoint_id, decision, reason}>, degraded?: "schema_incompatible" | "sqlite_only" }>`:
  - Invokes detector + classifier + recorder.
  - SQLite-only (Postgres → `degraded: "sqlite_only"`, empty records, no writes).
  - Returns aggregated summary.

### 7. `src/timeout/index.ts` (new, barrel)

Re-export factories + classes + types.

### 8. `src/mcp/server.ts` — new tool `checkpoint.timeout_sweep`

Register ONE new MCP tool:
- Name: `checkpoint.timeout_sweep` (dot-separated, aligned with prior batch conventions)
- Zod input: `{ max_per_run?: number }` (optional override).
- Handler: delegate to `sweepCheckpointTimeouts(...)`. Returns the full result shape above. Never throws.
- Zero touches to other tool registrations; single addition only.

### 9. Lifecycle wiring — `src/api/server.ts` + `src/mcp/server.ts`

Instantiate `TimeoutSweepScheduler` alongside existing adapters. Env gate `VEGA_TIMEOUT_SWEEP_ENABLED !== "false"` (default enabled). Call `stop()` on shutdown. Mirror 12b/13a/14a/15a pattern — minimize invasiveness.

### 10. `docs/runbooks/l1-timeout-policy.md` (new) — operations doc

Required sections (grep-checkable):
1. `## Policy summary` — T1/T2 → presumed_sufficient; T3 / unknown → hard_failure.
2. `## Sweep triggers` — scheduler (60s default) + manual via MCP.
3. `## Tuning` — env vars `VEGA_TIMEOUT_SWEEP_INTERVAL_MS`, `VEGA_TIMEOUT_SWEEP_MAX_PER_RUN`, `VEGA_TIMEOUT_SWEEP_ENABLED`.
4. `## Inspecting outcomes` — how to query `checkpoint_failures` for `category = "l1_ttl_expired"` + correlating with host_tier.
5. `## When this fires unexpectedly` — common root causes (clock skew / high-latency downstream / host-tier misclassification) + remediation steps.

### 11. Tests (4 new files, ≥ 14 cases; no existing test touched)

- **`src/tests/timeout-config.test.ts`** — ≥ 3 cases: default / env override valid / env override invalid-fallback for intervalMs + maxPerRun + enabled toggle.
- **`src/tests/timeout-policy.test.ts`** — ≥ 4 cases: T1 → presumed_sufficient / T2 → presumed_sufficient / T3 → hard_failure / unknown → hard_failure.
- **`src/tests/timeout-recorder.test.ts`** — ≥ 4 cases: hard_failure row inserted into checkpoint_failures / presumed_sufficient does NOT insert / Postgres-stub no-op / failure during insert → logged, returns `{written: false}`.
- **`src/tests/timeout-scheduler.test.ts`** — ≥ 3 cases: enabled start → tick executes detect+classify+record / disabled config → no tick / stop() idempotent.

All tests hermetic: `:memory:` SQLite + manually-seeded checkpoint rows; no real HOME. Recorder tests prepare an isolated `checkpoint_failures` table via inline DDL in the test (same table shape as Wave 3 — copy the minimum columns needed: `id`, `checkpoint_id`, `reason`, `category`, `created_at`).

## Out of scope — do NOT touch

- `src/checkpoint/**` (Wave 3 sealed — detector queries its tables, never modifies files)
- `src/reconciliation/**`, `src/monitoring/vega-metrics.ts`, `metrics-fingerprint.ts`, `metrics.ts`, `dashboards/**`
- `src/scheduler/**`, `src/notify/**`, `src/sunset/**`, `src/alert/**`, `src/backup/**`, `src/retrieval/**`
- `src/db/migrations/**`, `src/core/contracts/**`
- All existing `src/tests/*.test.ts` (only 4 new `timeout-*.test.ts` files allowed)

## Forbidden patterns (Wave 5 全程继续)

- Production 代码不得嗅探测试环境
- 测试不得触碰 macOS 真实钥匙串 / 真实 HOME / 真实 user config
- 不 amend `e48c9d9` / `45a6a91`；新起 commit
- Scheduler `setInterval` only (禁 fs.watch / chokidar / fsevents)
- Detector / recorder / sweepCheckpointTimeouts 永不抛；错误 → logger + 返 partial with degraded field
- Policy classifier is **pure function** (no DB / no side effects) — enforced by not passing `db` into `classifyTimeout`
- 不修改 Wave 3 checkpoint schema（若缺字段 → degraded, fire a follow-up, never silently change)

## Acceptance criteria

1. 7 新 `src/timeout/` files: `config.ts` / `detector.ts` / `policy.ts` / `recorder.ts` / `scheduler.ts` / `mcp.ts` / `index.ts`
2. `rg -nE "setInterval" src/timeout/scheduler.ts` ≥ 1; `rg -nE "fs\.watch|chokidar|fsevents" src/timeout/` zero
3. `rg -nE "parsed\s*>\s*0" src/timeout/config.ts` ≥ 2 (interval + maxPerRun env guards)
4. `rg -nE "if\s*\(\s*db\.isPostgres\s*\)" src/timeout/recorder.ts` ≥ 1 (Postgres safe-path guard)
5. `rg -nE "checkpoint\.timeout_sweep" src/mcp/server.ts` ≥ 1
6. `docs/runbooks/l1-timeout-policy.md` exists with 5 section headings (each ≥ 1 match)
7. 4 new `timeout-*.test.ts` files; total ≥ 14 test cases
8. `git diff HEAD --name-only -- src/` limited to `src/timeout/**` + `src/mcp/server.ts` + optional `src/api/server.ts` + 4 new test files
9. `git diff HEAD -- src/checkpoint/ src/scheduler/ src/notify/ src/sunset/ src/alert/ src/backup/ src/retrieval/ src/reconciliation/ src/monitoring/vega-metrics.ts src/monitoring/metrics-fingerprint.ts src/monitoring/metrics.ts dashboards/ src/db/migrations/ src/core/contracts/` outputs nothing
10. `git diff HEAD -- src/tests/` shows only 4 new `timeout-*.test.ts` files
11. `set -o pipefail; npm run build` exits 0; `set -o pipefail; npm test` ≥ 1141 pass / 0 fail
12. NOT an amend of `e48c9d9` / `45a6a91`; new commit stacked on top
13. Commit title prefix `feat(timeout):`
14. Commit body:
    ```
    Ships L1 checkpoint TTL timeout policy P8-023.1-.5:
    - src/timeout/{config,detector,policy,recorder,scheduler,mcp,index}.ts:
      detect L1 checkpoints past expires_at, classify by host_tier
      (T1/T2 → presumed_sufficient; T3/unknown → hard_failure to
      checkpoint_failures with category=l1_ttl_expired), self-managed
      setInterval scheduler (60s default, VEGA_TIMEOUT_SWEEP_INTERVAL_MS +
      _MAX_PER_RUN env with parsed > 0), dispose()-style stop().
    - New MCP tool checkpoint.timeout_sweep for manual sweep with optional
      max_per_run override. Never throws; degraded: sqlite_only on Postgres,
      schema_incompatible if Wave 3 schema predates expires_at column.
    - Lifecycle wiring in src/api/server.ts + src/mcp/server.ts mirrors
      12b/13a/14a/15a (VEGA_TIMEOUT_SWEEP_ENABLED env gate, dispose on
      shutdown). Wave 3 checkpoint code byte-locked; detector queries
      existing tables read-only.
    - docs/runbooks/l1-timeout-policy.md: policy summary / sweep triggers /
      tuning / inspecting outcomes / when this fires unexpectedly.
    - 4 new timeout-*.test.ts files with ≥ 14 hermetic cases (:memory:
      SQLite, inline-DDL checkpoint_failures fixture, no real HOME).

    Scheduler self-managed in src/timeout/; zero touches to src/scheduler/.
    Classifier is a pure function (no db). Recorder is Postgres-safe.

    Scope-risk: low
    Reversibility: clean (disable via VEGA_TIMEOUT_SWEEP_ENABLED=false; MCP
    tool remains usable regardless)
    ```

## Review checklist

- Is `classifyTimeout(...)` pure (no db, no side effects)?
- Does `resolveTimeoutSweepConfig` use `parsed > 0` (not `>= 0`) for both env vars?
- Does `recordTimeoutFailure` guard with `if (db.isPostgres)` as a safe-path?
- Is `checkpoint.timeout_sweep` registered exactly once in `src/mcp/server.ts`?
- Are tests using `:memory:` SQLite + inline-DDL for the `checkpoint_failures` shadow table (not reaching into `src/checkpoint/**`)?
- Does `detectExpiredCheckpoints` gracefully return `[]` if the schema predates `expires_at` (no throw, degraded path)?
- Is the scheduler in `src/timeout/scheduler.ts` (not `src/scheduler/`)?
- Does the new commit stack on `45a6a91` (not an amend)?

## Commit discipline

- Single atomic commit, new stack on HEAD
- Prefix `feat(timeout):`
- Body per Acceptance #14
- No root-level markdown / other docs except `docs/runbooks/l1-timeout-policy.md`
