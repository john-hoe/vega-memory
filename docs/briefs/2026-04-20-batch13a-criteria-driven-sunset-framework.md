# Batch 13a — Criteria-driven sunset framework (P8-033.1-.6 closure)

## Context

P8-033 (Wave 5) needs a sunset framework for deprecating legacy components. Design picks:
- **Subject**: Q1(a) — only legacy API routes / deprecated endpoints (keep scope tight; enum values / env flags / dead tools can extend later by adding to the same registry).
- **Trigger**: Q2(β) — manual MCP tool `sunset.check` + daily self-managed scheduler; threshold-meeting candidates emit notification. **Never auto-delete code or config** — human decides the PR.
- **Criteria**: Q3(iii) — `usage_threshold` OR `time_based` (whichever fires first).
- **Registry**: Q4(x) — YAML config `docs/sunset-registry.yaml` checked-in; starter is empty (`sunsets: []`) with schema-doc inline so real candidates land as a PR with clear diff.
- **Lifecycle**: Scheduler is self-managed inside `src/sunset/` (like HostMemoryFileAdapter's setInterval lifecycle) — **do NOT touch `src/scheduler/**`**.

All 6 subs of P8-033 land in this single batch: .1 criteria 定义 / .2 MCP tool / .3 每日 cron / .4 notification + Changelog / .5 tests / .6 rollback playbook.

## Scope

### 1. `docs/sunset-registry.yaml` (new)

Starter registry — empty list with schema-doc as comments:
```yaml
# Vega sunset candidate registry (P8-033).
# Each entry declares a legacy API route / endpoint targeted for eventual sunset.
# Evaluator fires when EITHER `usage_threshold` OR `time_based` criterion is met.
#
# Schema (zod-enforced in src/sunset/registry.ts):
#   - id: kebab-case-string         # unique, stable
#   - type: "api_route"             # initial scope (Q1a); future: enum_value / env_flag / mcp_tool
#   - target: string                # e.g. "POST /memory_store"
#   - deprecated_since: ISO-8601 date  # e.g. "2026-01-15"
#   - criteria:
#       usage_threshold:
#         metric: string            # Prometheus metric name
#         window_days: integer > 0
#         max_calls: integer >= 0   # threshold below which criterion fires
#       time_based:
#         min_days_since_deprecated: integer > 0
#   - notification:
#       changelog: boolean          # append Changelog entry when ready
#       log_level: "info" | "warn" | "error"
#
# Both usage_threshold and time_based are OPTIONAL but at least ONE must be present.
# Evaluator status per candidate: "ready" (met ≥1 criterion) | "pending" | "skipped" (schema invalid).
sunsets: []
```

### 2. `src/sunset/registry.ts` (new)

- zod schema `SunsetCandidateSchema` matching the YAML above.
- `loadSunsetRegistry(path: string): SunsetCandidate[]` — read YAML, parse via zod; on file missing OR `sunsets: []` OR schema violation, return `[]` (log warn for the violation case; do NOT throw). Path defaults to `docs/sunset-registry.yaml` resolved from cwd.
- Zod rules:
  - `id`: matches `/^[a-z0-9-]+$/`, 3-64 chars
  - `type`: literal `"api_route"` (Q1a; future waves extend)
  - `target`: non-empty string
  - `deprecated_since`: `YYYY-MM-DD` via regex; strict parse — no timezone
  - At least one of `usage_threshold` / `time_based` present
  - `window_days > 0`, `max_calls >= 0`, `min_days_since_deprecated > 0`
  - `notification.log_level`: enum literal

### 3. `src/sunset/evaluator.ts` (new)

- `SunsetStatus = "ready" | "pending" | "skipped"`
- `SunsetEvaluationResult = { candidate_id, status, reasons: string[], evaluated_at: string }`
- `evaluateSunsetCandidates(candidates, { db, now, metricsQuery }): SunsetEvaluationResult[]`
  - For each candidate: check `time_based` first (simple date math: `(now - deprecated_since) >= min_days_since_deprecated`), then `usage_threshold` (query metric; if null, reason = "metric_unavailable" → still "pending" not "ready").
  - OR logic: ANY criterion "ready" → overall "ready"; else "pending".
  - `reasons` array lists which criteria fired / which were "pending" reasons (e.g. `["time_based: 95 days elapsed ≥ 90"]`).
- `metricsQuery` is a thin injected interface `(metric: string, windowDays: number) => Promise<number | null>` — abstract so test + production use same code path. Test supplies stub; production wires into existing Prometheus-query layer. If no production query layer available, inject `() => Promise.resolve(null)` — all candidates with only `usage_threshold` stay "pending" with reason "metric_unavailable". This is acceptable (human can still see time-based readiness).

### 4. `src/sunset/scheduler.ts` (new)

- Class `SunsetScheduler` — self-managed like `HostMemoryFileAdapter`:
  - Constructor: `{ evaluator, intervalMs, notifier, registry }`
  - `start()` — sets `setInterval(() => this.tick(), intervalMs)`. Timer `unref()`-ed.
  - `stop()` — clears interval, idempotent.
  - `tick()` — reload registry + evaluate + for each "ready" candidate: invoke `notifier` (once per candidate per day — in-memory Set keyed by `candidate_id@YYYY-MM-DD` to dedupe).
- `intervalMs`:
  - Default 24 * 3600 * 1000 = 86_400_000 ms (daily)
  - Env override `VEGA_SUNSET_CHECK_INTERVAL_MS` via `Number.parseInt(..., 10)`, `parsed > 0` guard (match 12b pattern).
- NOT a singleton; instantiated at runtime entrypoints.

### 5. `src/sunset/notifier.ts` (new)

- Interface `SunsetNotifier = (event: SunsetReadyEvent) => Promise<void>`
- Default implementation `createChangelogNotifier(changelogPath: string): SunsetNotifier`:
  - Appends a timestamped line to `CHANGELOG.md` (create if missing) in the form:
    ```
    ## Sunset candidate ready: <id>
    - Target: <target>
    - Deprecated since: <YYYY-MM-DD>
    - Criteria met: <reasons joined by "; ">
    - Detected at: <ISO timestamp>
    ```
  - Also emits via existing logger at the `log_level` from candidate notification config (reuse `src/monitoring/logger.ts` or equivalent; if module location differs, stick to `console.warn`/`console.info` fallback).

### 6. `src/sunset/index.ts` (new, barrel)

Re-exports: `loadSunsetRegistry`, `evaluateSunsetCandidates`, `SunsetScheduler`, `createChangelogNotifier`, all types.

### 7. `src/mcp/server.ts` — new tool `sunset.check`

Register ONE new MCP tool (dot-separated, matching `host_memory_file.refresh` / `reconciliation.run`):
- Name: `sunset.check`
- Zod input: `{ registry_path: string }` (optional, defaults to `docs/sunset-registry.yaml`)
- Handler: load registry → evaluate → return `{ schema_version: "1.0", evaluated_at: <ISO>, candidates: SunsetEvaluationResult[], degraded?: "registry_missing" | "parse_error" }`
- Never throws. Missing file → `degraded: "registry_missing"` + empty `candidates`; schema error → `degraded: "parse_error"` + empty `candidates`.
- Do NOT touch any other tool registration.

### 8. Lifecycle wiring — `src/api/server.ts` + `src/mcp/server.ts`

Instantiate `SunsetScheduler` alongside existing `HostMemoryFileAdapter` construction in both entrypoints. Call `scheduler.start()` after construction; add to shutdown path so `scheduler.stop()` fires on SIGTERM / test cleanup. Mirror the `dispose()`-exposure approach from 12b.

Environment-gated: if `VEGA_SUNSET_SCHEDULER_ENABLED !== "false"`, start. Default: enabled.

### 9. `docs/runbooks/sunset-rollback.md` (new)

Mandatory sections (grep-checkable headings):
1. `## When to rollback a sunset` — triggers (reversed decision / usage rebound / stakeholder pushback).
2. `## Rollback procedure`:
   - Step 1: remove candidate entry from `docs/sunset-registry.yaml`.
   - Step 2: revert any `CHANGELOG.md` lines that referenced the rollback-ed candidate (optional — document can stay as history if prefered).
   - Step 3: re-deploy.
3. `## Verify rollback` — check that `sunset.check` no longer lists the candidate + metrics/flags restored.
4. `## Post-mortem checklist` — why the sunset criteria were premature; adjust `usage_threshold` / `time_based` for future candidates.

### 10. Tests (new files; existing tests untouched)

- **`src/tests/sunset-registry.test.ts`** — ≥ 5 cases:
  - Valid minimal entry (only `time_based`)
  - Valid minimal entry (only `usage_threshold`)
  - Both criteria present
  - Schema violations: missing both criteria / invalid id / invalid date / invalid log_level — each returns `[]` + warn log
  - File-missing → returns `[]` + warn log
- **`src/tests/sunset-evaluator.test.ts`** — ≥ 6 cases:
  - `time_based` fires alone (95 days > 90)
  - `time_based` pending (60 days < 90) → `"pending"`
  - `usage_threshold` fires (actual 2 calls < 10 threshold)
  - `usage_threshold` pending (actual 50 > 10)
  - `metricsQuery` returns null → `"pending"` with reason `metric_unavailable`
  - OR logic: time_based ready + usage pending → `"ready"` (time criterion cited in reasons)
- **`src/tests/sunset-mcp.test.ts`** — ≥ 3 cases:
  - Happy path: 1 ready + 1 pending → tool returns both with correct status
  - Registry missing → `degraded: "registry_missing"`
  - Registry invalid YAML → `degraded: "parse_error"`
- **`src/tests/sunset-scheduler.test.ts`** — ≥ 3 cases:
  - `start()` → `tick()` fires evaluator; ready candidate triggers notifier exactly once (dedupe verified by calling `tick()` twice in same "day" via injected `now` returning same date)
  - `stop()` clears interval; idempotent (two consecutive `stop()` calls no-op)
  - Env `VEGA_SUNSET_CHECK_INTERVAL_MS="0"` falls back to default (matches 12b `parsed > 0` pattern)

## Out of scope — do NOT touch

- `src/reconciliation/**` (byte-locked since 11a)
- `src/monitoring/vega-metrics.ts` / `metrics-fingerprint.ts` / `metrics.ts` / `dashboards/**`
- `src/scheduler/**` (entire directory — this batch does NOT rely on scheduler; sunset has its own self-managed timer in `src/sunset/scheduler.ts`)
- `src/notify/**` (out of scope; simple Changelog + logger only)
- `src/db/migrations/**` / `src/core/contracts/**`
- `src/retrieval/**` (all byte-locked from 12a/.1/12b)
- `src/tests/*.test.ts` except the 4 new sunset test files
- All prior batch Out-of-scope files

## Forbidden files

- All prior batch Out-of-scope lists (inherited).
- `src/scheduler/**` (byte-locked; sunset has its own scheduler module)
- `src/notify/**` (not extended here; Changelog notifier is inline in `src/sunset/notifier.ts`)
- All existing `src/tests/*.test.ts` (only 4 new sunset test files allowed)
- Root-level markdown files (no new README / TODO)
- `docs/**` except this brief + `docs/sunset-registry.yaml` + `docs/runbooks/sunset-rollback.md`

## Forbidden patterns (Wave 5 全程继续)

- Production 代码不得嗅探测试环境
- 测试不得触碰 macOS 真实钥匙串 / 真实 HOME / 真实 user config
- 不 amend `9016800` / `8689fef`；新起 commit
- Scheduler 模块必须用 `setInterval` polling（不得 fs.watch / chokidar / fsevents）
- `evaluateSunsetCandidates` 不得自动修改代码 / 注册表文件 / CI 配置（Q2β — 只通知，不自动 sunset）
- `SunsetNotifier` 实现不得抛错；错误走 logger + 返回 void

## Acceptance criteria

1. `docs/sunset-registry.yaml` 存在，`grep -cE '^sunsets:' docs/sunset-registry.yaml` ≥ 1，`grep -cE '^  - id:' docs/sunset-registry.yaml` = 0 (starter empty)
2. `src/sunset/{registry,evaluator,scheduler,notifier,index}.ts` 5 个新文件存在
3. `grep -nE 'setInterval' src/sunset/scheduler.ts` ≥ 1；`grep -nE 'fs\.watch|chokidar|fsevents' src/sunset/` 零命中
4. `grep -nE 'parsed\s*>\s*0' src/sunset/scheduler.ts` ≥ 1（env fallback guard）
5. `grep -nE 'stop\s*\(\s*\)' src/sunset/scheduler.ts` ≥ 1（idempotent stop method）
6. `grep -nE 'sunset\.check' src/mcp/server.ts` ≥ 1（新 tool 注册）
7. `docs/runbooks/sunset-rollback.md` 存在，4 个 section heading 各 ≥ 1
8. 4 个新 test 文件：`src/tests/sunset-registry.test.ts` / `sunset-evaluator.test.ts` / `sunset-mcp.test.ts` / `sunset-scheduler.test.ts` 各存在；test case 总计 ≥ 17 (5+6+3+3)
9. `git diff HEAD --name-only -- src/` 仅：`src/sunset/{registry,evaluator,scheduler,notifier,index}.ts` + `src/mcp/server.ts` + (可选) `src/api/server.ts` + 4 个新 test 文件。其他 src/ 零变动
10. `git diff HEAD -- src/scheduler/ src/notify/ src/reconciliation/ src/monitoring/ dashboards/ src/db/migrations/ src/core/contracts/ src/retrieval/` 输出为空
11. `git diff HEAD -- src/tests/` 仅显示 4 个新 sunset test 文件；其他 test 文件零变动
12. `set -o pipefail; npm run build` 成功；`set -o pipefail; npm test` 全绿（预期 ≥ 1075 pass）
13. 严格**不 amend** commit `9016800` / `8689fef`；新起 commit
14. Commit title 前缀 `feat(sunset):`
15. Commit body:
    ```
    Ships the criteria-driven sunset framework P8-033.1-.6:
    - docs/sunset-registry.yaml (empty sunsets:[] starter + schema doc).
    - src/sunset/{registry,evaluator,scheduler,notifier,index}.ts with
      zod-validated candidate schema, OR-logic evaluator (usage_threshold
      OR time_based — whichever fires first), self-managed setInterval
      scheduler with dispose()-style stop(), and Changelog-append default
      notifier.
    - New MCP tool sunset.check (schema_version "1.0", handles registry
      missing/parse-error as degraded paths, never throws).
    - Lifecycle wiring in src/api/server.ts + src/mcp/server.ts mirrors
      12b HostMemoryFileAdapter pattern: env-gated start
      (VEGA_SUNSET_SCHEDULER_ENABLED default enabled), stop() on shutdown.
    - docs/runbooks/sunset-rollback.md: when/how/verify rollback + post-
      mortem checklist for premature sunset decisions.
    - 4 new test files (registry/evaluator/mcp/scheduler) with ≥ 17 cases
      covering happy paths, schema violations, degraded MCP paths, and
      env fallback.

    Scope constraints: scheduler self-managed in src/sunset/ — zero
    touches to src/scheduler/. Sunset never auto-modifies code; it only
    notifies via Changelog + logger so a human owns the PR.

    Scope-risk: low
    Reversibility: clean (registry entries can be removed per runbook)
    ```

## Review checklist

- Registry YAML 是空 `sunsets: []` starter 吗？（不是硬编码真实 candidates）
- Evaluator 是 OR logic 吗？（不是 AND；time_based ready + usage pending → overall ready）
- `src/sunset/scheduler.ts` 用 `setInterval` 且 env guard 是 `parsed > 0`？（不是 `>= 0`）
- `SunsetScheduler.stop()` 是否 idempotent？（test case 覆盖）
- MCP tool `sunset.check` handler 在 registry missing / parse_error 时返回 degraded 不抛错？
- `src/scheduler/**` 是否零变动？（`git diff HEAD -- src/scheduler/` 空）
- Sunset 是否「仅通知、不自动删代码」？（notifier 只 append Changelog + log；registry 变更靠人工 PR）
- 4 个 test 文件是否均 hermetic（用 mkdtempSync tmp HOME，不读真实 `docs/sunset-registry.yaml`）？
- 新 commit 叠 `8689fef` 下方，不 amend？

## Commit discipline

- 单 atomic commit，新起
- 前缀 `feat(sunset):`
- body 按 Acceptance #15
- 不创建 root-level markdown / 其他 docs 除 `docs/sunset-registry.yaml` + `docs/runbooks/sunset-rollback.md`
