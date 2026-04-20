# Batch 11a.1 — Close Round-1 findings on fc52ad7: Count scope + retention protect_run_id

## Problem
Round-1 review on commit `fc52ad7` (Batch 11a) returned **BLOCK** with 2 findings:

**HIGH** — `src/reconciliation/count-dimension.ts:164` forward pass filters `source IN ('explicit')` + `source_context.integration === 'candidate_promotion'`, but `shadow-aware-repository` intercepts **every** `createMemory` / `createFromCandidate` call regardless of `source` (it's a Proxy over Repository write methods). `source` is metadata, NOT a shadow scope key. Production has `source: "auto"` write paths (message synthesis, session autosave via `src/core/memory.ts:530` + `src/core/session.ts:530`); those get shadowed into raw_inbox but are excluded from the reconciliation `expected` count — yielding false `pass` when shadow didn't actually drop anything. Reviewer provided runtime repro.

**MEDIUM** — `src/reconciliation/retention.ts:44` `pruneFindings()` deletes oldest rows globally by `created_at, id` without excluding the current `run_id`. Orchestrator runs prune after insertion (`orchestrator.ts:62,96`), but low `VEGA_RECONCILIATION_RETENTION_MAX_ROWS` can cull findings from the just-completed run. Reviewer repro: `MAX_ROWS=2` + run generating 5 findings → only 2 rows survived for that run_id. Violates the "current run preserved" promise in 11a brief.

Root cause (HIGH): 11a brief Scope §3 incorrectly stated source filter semantics. Fix applies to code; brief's incorrect statement is now superseded.

## Scope

### 1. Widen Count forward pass — `src/reconciliation/count-dimension.ts`
Drop the source filter from the forward-pass SQL. `expected` = every memory created in `[window_start, window_end)`, regardless of `source` or `source_context`.

**Rationale comment** (must appear adjacent to the forward-pass SQL in the file):
```
// Forward pass counts ALL memories created in window.
// shadow-aware-repository is a Proxy wrapping Repository.createMemory +
// Repository.createFromCandidate — it intercepts every write regardless
// of source or source_context. source is metadata, not a shadow scope key.
// Filtering by source here would create false pass results whenever a
// source type outside the filter (e.g., "auto") is shadowed.
```

Keep the `event_type` mapping intact on the raw_inbox side (still compare against `decision` / `state_change` envelopes per 11a's shadow-aware-repository mapping rules; that's about event_type on the shadow side, not memory source filtering on the main side).

### 2. Protect current run in retention — `src/reconciliation/retention.ts`
Add an optional `protect_run_id` parameter to `pruneFindings()`:
```ts
export interface PruneFindingsOptions {
  now?: () => number;
  retention_days?: number;
  retention_max_rows?: number;
  protect_run_id?: string;   // NEW
}
```

Both prune branches (age-based + row-count-based) must exclude `run_id = protect_run_id` from deletion when the param is set. Use `AND run_id != ?` on the DELETE SQL.

### 3. Wire current run protection — `src/reconciliation/orchestrator.ts`
When calling `pruneFindings()` at end of `run()`, pass the current `run_id` as `protect_run_id`.

### 4. Tests
- **`src/tests/reconciliation-count.test.ts`** — add test case: memory with `source: "auto"` written in window gets counted as `expected` (test would have caught the HIGH bug). Keep all existing count tests green.
- **`src/tests/reconciliation-retention.test.ts`** (new file) OR existing retention block in orchestrator test — add:
  - `MAX_ROWS=2` + run generating 5 findings → **all 5 findings of the current run remain** (exact count, not "at least N"). Must use `listReconciliationFindings(db, { run_id })` and assert `length === 5`.
  - Multi-run scenario: older run's rows can still be pruned while current run is protected. Proves `protect_run_id` only excludes current, not all runs.

## Out of scope — do NOT touch
- Any other file in `src/reconciliation/` beyond the 3 listed (count-dimension.ts / retention.ts / orchestrator.ts)
- `src/reconciliation/findings-store.ts` (table schema / indexes unchanged)
- `src/reconciliation/report.ts` / `src/reconciliation/index.ts`
- `src/api/server.ts` / `src/mcp/server.ts` (wiring unchanged)
- 10a metrics stack (byte-locked)
- 10a.1 revert-locked files
- `dashboards/`, `src/scheduler/`, `src/notify/`, `src/db/migrations/`, `src/core/contracts/`

## Forbidden files
- All prior batch Out-of-scope (inherited)
- `src/monitoring/**` — byte-locked
- `dashboards/**`, `src/scheduler/**`, `src/notify/**`, `src/db/migrations/**`, `src/core/contracts/**`
- Existing `src/tests/**.ts` except the 1-2 files listed in Scope #4
- `docs/**` except this brief
- Root-level markdown
- This brief itself

## Forbidden patterns (Wave 5 全程继续)
- Production 代码不得嗅探测试环境
- 测试不得触碰 macOS 真实钥匙串 / HOME / user config
- 不 amend existing commits

## Acceptance criteria
1. `grep -nE 'source.*===.*"explicit"|candidate_promotion' src/reconciliation/count-dimension.ts` 返回空（source 过滤完全移除）
2. forward-pass rationale 注释块（Scope #1 中的那段）**原样**出现在 count-dimension.ts
3. `pruneFindings` signature 含 `protect_run_id?: string`（通过 grep 或类型定义核）
4. `grep -nE 'run_id != ?|run_id <> ?' src/reconciliation/retention.ts` 命中至少 1 处（age + row-count 两条删除 SQL 都应带排除子句）
5. orchestrator.ts 调 pruneFindings 时传入当前 `run_id` 作为 `protect_run_id`
6. `src/tests/reconciliation-count.test.ts` 存在 `source: "auto"` 场景测试
7. retention 测试断言 **"当前 run 的 5 条 findings 全留"**（`length === 5` 精确断言，不是 `>= 2`），且多 run 场景下旧 run 可被 prune
8. `npm run build` 成功退出；`npm test` 全绿（预期 ≥ 1018 pass，因新增至少 2 条测试 + 保留全部 1016 原始）
9. 严格**不 amend** commit `fc52ad7`，新起 commit
10. Commit title 前缀 `fix(reconciliation):`
11. Commit body:
    ```
    Closes Round-1 review findings on fc52ad7 (Batch 11a).

    - HIGH: widen Count forward-pass SQL to count ALL memories in window,
      not filtered by source. shadow-aware-repository is a Proxy over
      Repository.createMemory + createFromCandidate, intercepting every
      write regardless of source metadata. Previous filter would false-pass
      on source:"auto" paths (message synthesis, session autosave).
    - MEDIUM: add protect_run_id parameter to pruneFindings; orchestrator
      now passes current run_id so age-based AND row-count-based retention
      cannot delete findings from the just-completed run.

    Scope-risk: low
    Reversibility: clean
    ```
12. Forbidden files diff 零变动（`git diff HEAD -- src/monitoring/ dashboards/ src/scheduler/ src/notify/ src/db/migrations/ src/core/contracts/ src/api/server.ts src/mcp/server.ts`）
13. `src/reconciliation/findings-store.ts` / `report.ts` / `index.ts` 字节未变

## Review checklist
- count-dimension.ts 的 source 过滤是否真的删干净（SQL 字符串里也不能残留）？
- rationale 注释是否紧贴 SQL 代码（而非孤立在文件顶部）？
- pruneFindings 的 age 删除和 row-count 删除两条路径都加了 `run_id != ?` 排除？
- orchestrator 传的 run_id 是 `ReconciliationOrchestrator.run()` 本次调用生成的那个（非空）？
- retention 测试是否严格 `length === 5`，不是 `>= 2`？
- 多 run 场景测试：是否真覆盖"旧 run 被 prune 同时当前 run 被豁免"两面？
- auto source 测试：用的是真实 `source: "auto"` 创建路径还是伪造的？应当走 `Repository.createMemory(...)` 正常流程
- 有没有误碰 Forbidden files？

## Commit discipline
- 单 atomic commit，新起，不 amend
- 前缀 `fix(reconciliation):`
- body 按 Acceptance #11 模板
- 不创建 markdown / root-level 文档
