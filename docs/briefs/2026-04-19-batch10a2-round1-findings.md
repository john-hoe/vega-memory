# Batch 10a.2 — Round-1 review findings close-out

## Context
Round-1 auto-review on commits `7692b92` (Batch 10a) + `06b49e9` (Batch 10a.1) returned verdict **BLOCK** with 4 findings. This batch closes the 3 actionable findings (1 LOW + 2 MEDIUM). The HIGH finding is retrospective-only — already reverted by 06b49e9, no code action needed.

## Scope
1. **MEDIUM — scheduler test regex creep + config hermeticity**
   - File: `src/tests/scheduler.test.ts`
   - Revert regex at line 236 from `/^memory-\d{4}-\d{2}-\d{2}\.db(?:\.enc)?$/` back to `/^memory-\d{4}-\d{2}-\d{2}\.db$/`
   - In the same test's config construction, **explicitly set `dbEncryption: false`** so the test is hermetic against any ambient `~/.vega/config.json` encryption setting. If the config is constructed via a helper, add the flag at call-site; don't touch the helper signature unless unavoidable
   - Verify the test still passes (if it fails because the scheduler path genuinely produces `.enc` backups regardless of config, escalate — do NOT re-widen the regex)

2. **MEDIUM — circuit-breaker enum canonicalization**
   - File: `src/retrieval/circuit-breaker.ts`
     - Add two new exports before the existing type declarations:
       ```ts
       export const CIRCUIT_BREAKER_STATES = ["closed", "open", "cooldown"] as const;
       export const CIRCUIT_BREAKER_TRIP_REASONS = ["low_ack_rate", "high_followup_rate"] as const;
       ```
     - Change existing types to derive from these arrays:
       ```ts
       export type CircuitBreakerState = (typeof CIRCUIT_BREAKER_STATES)[number];
       export type CircuitBreakerTripReason = (typeof CIRCUIT_BREAKER_TRIP_REASONS)[number];
       ```
     - No other logic change in this file
   - File: `src/monitoring/vega-metrics.ts`
     - Delete the local hardcoded declarations at lines 33-34 (`const CIRCUIT_BREAKER_STATES = ...` / `const CIRCUIT_BREAKER_TRIP_REASONS = ...`)
     - Add `import { CIRCUIT_BREAKER_STATES, CIRCUIT_BREAKER_TRIP_REASONS } from "../retrieval/circuit-breaker.js";` (merge with existing circuit-breaker import if present)
     - All downstream consumers (line 60 `CIRCUIT_BREAKER_STATE_VALUES`, lines 85 / 88 `coerceKnownValue` / `isKnownValue`) continue to reference the same identifier names — no further consumer-side change needed

3. **LOW — remove unreachable SQL defensive clause**
   - File: `src/monitoring/vega-metrics.ts`
   - The raw_inbox age gauge SQL currently has `HAVING COUNT(*) > 0 AND MIN(received_at) IS NOT NULL`. The `MIN(received_at) IS NOT NULL` clause is unreachable because `received_at TEXT NOT NULL` at schema level (see `src/ingestion/raw-inbox.ts:23`).
   - Remove the `AND MIN(received_at) IS NOT NULL` clause
   - Add a SQL comment on the same query: `-- received_at is NOT NULL per raw_inbox schema; HAVING COUNT(*) > 0 is sufficient`
   - Do NOT add a test for the null branch (impossible to trigger given schema)

## Out of scope — do NOT touch
- Any existing metrics emit wiring (retrieval orchestrator / ack handler / circuit breaker transition logic)
- `src/retrieval/orchestrator.ts`, `src/usage/usage-ack-handler.ts`, `src/api/server.ts`, `src/monitoring/metrics.ts`（collector 核心不动）
- The 4 revert-locked files from 10a.1: `src/config.ts`, `src/security/keychain.ts`, `src/core/integration-surface-status.ts`, `src/cli/commands/doctor.ts`
- `src/tests/config.test.ts`, `src/tests/doctor.test.ts` (10a.1 already cleaned them; don't re-touch)
- `src/tests/metrics-runtime.test.ts`, `src/tests/metrics-collector.test.ts`, `src/tests/metrics-api.test.ts`, `src/tests/metrics-edge.test.ts` (no test changes needed for this batch)
- DB schema, migrations, contracts
- `docs/**`, root-level markdown, this brief itself

## Forbidden patterns (Wave 5 全程继续生效)
- Production 代码不得嗅探测试环境 (`process.execArgv` / `NODE_ENV === "test"` / `isNodeTestEnvironment()` 等)
- Production 代码不得分支走"只在测试生效"的路径
- 测试隔离必须走 DI / 参数注入 / mock，不得改 production

## Acceptance criteria
1. `git grep -nE '^const (CIRCUIT_BREAKER_STATES|CIRCUIT_BREAKER_TRIP_REASONS)' src/monitoring/vega-metrics.ts` returns nothing (local declarations removed)
2. `git grep -nE '^export const (CIRCUIT_BREAKER_STATES|CIRCUIT_BREAKER_TRIP_REASONS)' src/retrieval/circuit-breaker.ts` returns exactly 2 lines (new exports)
3. `grep -nE 'CIRCUIT_BREAKER_STATES|CIRCUIT_BREAKER_TRIP_REASONS' src/monitoring/vega-metrics.ts` shows the imported identifiers used at the existing consumer sites (no drift)
4. `grep -nE '\\\\.enc' src/tests/scheduler.test.ts` returns nothing (regex reverted)
5. `grep -nE 'dbEncryption' src/tests/scheduler.test.ts` shows an explicit `dbEncryption: false` set somewhere in the test's config construction
6. `grep -nE 'MIN\\(received_at\\) IS NOT NULL' src/monitoring/vega-metrics.ts` returns nothing (unreachable clause removed)
7. `grep -nE 'received_at is NOT NULL per raw_inbox schema' src/monitoring/vega-metrics.ts` returns the new SQL comment
8. `npm run build` + `npm test` 全绿
9. **Not amend** commit `06b49e9` — new commit on top of it
10. Commit title prefix `fix(monitoring):` or `fix(metrics):`
11. Commit body template:
    ```
    Closes Round-1 review findings on commits 7692b92 + 06b49e9.

    - MEDIUM: revert scheduler test regex creep (.enc suffix) and pin
      dbEncryption to false in test config for proper hermeticity.
    - MEDIUM: canonicalize circuit breaker state/reason enums with runtime
      const arrays exported from circuit-breaker.ts; vega-metrics.ts now
      imports the source of truth instead of duplicating literals.
    - LOW: remove unreachable MIN(received_at) IS NOT NULL defensive clause
      in raw_inbox age gauge SQL; received_at is NOT NULL per schema so
      HAVING COUNT(*) > 0 alone is sufficient. SQL comment added.
    - HIGH (retrospective): 7692b92 introduced forbidden test sniffing in 4
      production files; fully reverted by 06b49e9, no action required here.

    Scope-risk: low
    Reversibility: clean
    ```

## Review checklist
- circuit-breaker.ts 只加了 2 个 `export const` + type 改写成 `(typeof ...)[number]`，没动其他逻辑？
- vega-metrics.ts 只做"删本地声明 + 加 import"+"SQL 删不可达子句 + 加注释"，没动其他 metric 注册 / emit / HELP？
- scheduler.test.ts 只改 regex 一行 + 加 `dbEncryption: false` 一处，没动其他测试逻辑？
- 新 commit 不 amend 06b49e9？
- 有没有意外碰 Forbidden files？

## Commit discipline
- 单 atomic commit，新起，不 amend
- 前缀 `fix(monitoring):`
- body 按 Acceptance #11 格式
- 不创建 markdown / root-level 文档
