# Batch 11c — Reconciliation aggregate integration tests (P8-032.7 closure)

## Context
P8-032 Reconciliation 5 矩阵 via 11a-11b.1 stack (commits `fc52ad7..9c54e4e`) has 6/8 subs sealed: .1 Count / .2 Shape / .3 Semantic α / .4 Ordering / .6 MCP tool / .8 findings retention. Individual dim unit tests + MCP tool tests + retention tests are in place (≥ 1039 tests pass).

**What's still missing**: aggregate integration coverage — a single run where shadow/main diverge across multiple dimensions simultaneously, exercising the full pipeline (Repository.createMemory + shadow-aware-repository + insertRawEvent) to prove maligned dims don't step on each other, and that findings persistence + retention work end-to-end across multiple runs.

This batch (11c) is the **collapse batch** for P8-032: ship one new test file, then close P8-032.7 ✅ and flip P8-032.5 → ⏭️ 跳过 (Q4 α decision — Wave 5 not doing Derived), so parent P8-032 can seal ✅.

Deferred follow-ups (unchanged):
- GitHub #43: scheduler auto-trigger
- GitHub #44: NotificationManager alert wiring
- GitHub #45: Wave 6 enum canonicalization

## Scope

### 1. New file `src/tests/reconciliation-integration.test.ts`
Single new test file, ≥ 3 test cases covering:

#### Case A — 5-dim aggregate divergence
Using **realistic pipeline** (Repository.createMemory → shadow-aware-repository → insertRawEvent):
- Seed 3 memories in window:
  - Memory #1: shadow envelope missing entirely (Count forward miss scenario)
  - Memory #2: shadow envelope has field value mismatch on `content` (Shape + Semantic scenarios simultaneously — same root cause)
  - Memory #3: shadow envelope `received_at` is 10s off from main `created_at` (Ordering beyond default 5s tolerance)
- Additionally: seed 1 orphan envelope in raw_inbox with no corresponding memory (Count reverse orphan)
- Invoke `orchestrator.run(window)` with dimensions = all 5
- Assert:
  - `count` dim: status=fail, findings include both forward miss (sample_ids contains Memory #1) AND reverse orphan finding
  - `shape` dim: status=fail, finding lists `content` as value_mismatch field
  - `semantic` dim: status=fail (hash mismatch) — NOTE: may need `VEGA_RECONCILIATION_SEMANTIC_SAMPLE_SIZE` override to ensure Memory #2 is sampled
  - `ordering` dim: status=fail, delta_ms ≥ 10000
  - `derived` dim: status=not_implemented (stub preserved — critical: aggregate fail of 4 dims must NOT corrupt Derived)
  - Report totals: pass=0, fail=4, not_implemented=1, error=0

#### Case B — Per-dim isolation under real error
- Construct a fixture where one dim genuinely throws (suggested: corrupt `raw_inbox.payload_json` to non-JSON string so Shape or Semantic's `JSON.parse` throws)
- Invoke `orchestrator.run(window)` with all 5 dims
- Assert:
  - The throwing dim: status=error, `error` field populated with message
  - Other 4 dims: still complete with their respective status (pass/fail/not_implemented)
  - No unhandled promise rejection / thrown exception bubbles up

#### Case C — Findings 持久化 multi-run round-trip
- Run `orchestrator.run(...)` 3 times with distinct non-overlapping windows (each producing findings)
- After each run: assert `listReconciliationFindings(db, { run_id })` length matches the report's finding count for that run
- After 3 runs: assert total rows in `reconciliation_findings` table = sum of per-run counts
- Set `VEGA_RECONCILIATION_RETENTION_MAX_ROWS` low enough that retention should prune older runs
- Assert older run's findings count drops to 0 (protect_run_id preserves current run but allows earlier runs to be pruned)

### 2. Test constraints
- Hermetic: `:memory:` SQLite DB; no real HOME / keychain / user config touches
- Must construct via real `Repository.createMemory` + `createShadowAwareRepository` + `insertRawEvent` APIs; no direct SQL seed for the happy-path fixtures (exception: deliberately corrupt data for Case B can use `db.run("UPDATE ...")`)
- No new production code required
- Do NOT add helper utilities to existing test files (keep concentrated in this new file; duplicate small setup helpers if necessary)

## Out of scope — do NOT touch
- Any production code under `src/reconciliation/`
- Any existing test file (`src/tests/reconciliation-count.test.ts` / `reconciliation-orchestrator.test.ts` / `reconciliation-mcp.test.ts` / `reconciliation-retention.test.ts` / `reconciliation-shape.test.ts` / `reconciliation-semantic.test.ts` / `reconciliation-ordering.test.ts`)
- Derived dim logic (Wave 6)
- Scheduler auto-trigger, NotificationManager wiring, metric emit (deferred)
- 10a metrics stack, dashboards/, 10a.1 revert-locked files
- `src/api/server.ts` / `src/mcp/server.ts` wiring unchanged

## Forbidden files
- All prior batch Out-of-scope files (inherited)
- All `src/reconciliation/**` files (byte-locked; new test reads them but doesn't modify)
- All existing `src/tests/reconciliation-*.test.ts` files (byte-locked; only new file allowed)
- `src/monitoring/**` / `dashboards/**` / `src/scheduler/**` / `src/notify/**` / `src/db/migrations/**` / `src/core/contracts/**` / `src/api/server.ts` / `src/mcp/server.ts`
- `docs/**` except this brief
- Root-level markdown files
- This brief itself

## Forbidden patterns (Wave 5 全程继续)
- Production 代码不得嗅探测试环境
- 测试不得触碰 macOS 真实钥匙串 / 真实 HOME / 真实 user config
- Case B 的"制造错误"场景必须通过 DB 层数据破坏实现，**不得**临时修改 production 代码抛错测试
- Case A 的 fixture 构造必须走真实 Repository / shadow-aware / insertRawEvent API，**不得**纯 SQL seed 绕过 pipeline（Q2 α 决策）

## Acceptance criteria
1. 新文件 `src/tests/reconciliation-integration.test.ts` 存在
2. 至少 3 个 test case 覆盖 Case A / B / C 描述的场景
3. Case A 断言必须包含 Derived 维度 `status: "not_implemented"`（防止 4 维 fail 污染 Derived stub）
4. Case A 的 fixture 构造**必须**调用 `Repository.createMemory` 或 `createShadowAwareRepository` 的 create 方法（grep 检查）；纯 SQL `INSERT INTO memories` seed 不满足
5. Case B 的一维 throw **不得**通过临时改 production 抛错实现；必须通过 DB 层数据腐败（corrupted payload_json 等）触发 natural throw
6. Case C 断言 `listReconciliationFindings` 返回长度与 report 一致 + retention 正确 prune 旧 run
7. `git diff HEAD -- src/reconciliation/` 输出为空（所有 production 代码字节锁定）
8. `git diff HEAD --name-only -- src/tests/` 只显示 `reconciliation-integration.test.ts` 一个新文件（grep existing test file names 不得出现）
9. `git diff HEAD -- src/monitoring/ dashboards/ src/scheduler/ src/notify/ src/db/migrations/ src/core/contracts/ src/api/server.ts src/mcp/server.ts` 输出为空
10. `npm run build` 成功退出；`npm test` 全绿（预期 ≥ 1042 pass，因至少 3 条新测试）
11. 严格**不 amend** commit `9c54e4e`，新起 commit 在其上
12. Commit title 前缀 `test(reconciliation):`
13. Commit body：
    ```
    Closes P8-032.7 (aggregate integration tests) via a single new test
    file reconciliation-integration.test.ts. Covers:
    - 5-dim divergence fixture built through the real pipeline (Repository
      .createMemory + shadow-aware-repository + insertRawEvent), proving
      no dim steps on another and Derived stub stays not_implemented even
      when all other 4 dims fail.
    - Per-dim isolation under a genuinely-throwing dim (corrupted payload
      triggers JSON.parse throw), proving orchestrator's try/catch isolates
      the failure without aborting the run.
    - Findings-store durability across 3 consecutive runs with varying
      windows, confirming listReconciliationFindings matches report counts
      and retention prunes older runs while protect_run_id preserves the
      current one.

    All 11a/11a.1/11b/11b.1 production code remains byte-locked; this
    batch is tests-only. Closes P8-032.7; closes parent P8-032 once
    P8-032.5 is separately marked ⏭️ 跳过 (Q4 α: Derived deferred to
    Wave 6).

    Scope-risk: none
    Reversibility: clean
    ```

## Review checklist
- `src/reconciliation/` 下所有文件 diff 是否为 0？
- 现有 test 文件是否一字未改？
- Case A 是否真走了 `Repository.createMemory` / `createShadowAwareRepository` / `insertRawEvent`（不是 SQL INSERT）？
- Case A 的 Derived 断言是否显式写 `status === "not_implemented"`（不是 `!= "fail"` 弱断言）？
- Case B 的"throw"是否通过数据腐败实现（不是临时修改 production 代码）？
- Case C 的 retention 断言是否真的验证了旧 run 被 prune（不只是断言行数 > 0）？
- 测试是否完全 hermetic（`:memory:` DB，无 HOME / keychain / user config 依赖）？
- 新 commit 是否叠 `9c54e4e` 下方，不 amend？

## Commit discipline
- 单 atomic commit，新起
- 前缀 `test(reconciliation):`
- body 按 Acceptance #13
- 不创建 markdown / root-level 文档
