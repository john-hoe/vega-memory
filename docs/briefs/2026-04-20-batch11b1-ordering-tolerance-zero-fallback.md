# Batch 11b.1 — Fix ordering tolerance 0/negative fallback contract

## Problem
Round-1 review on commit `fab12d6` (Batch 11b) returned **BLOCK** with 1 HIGH finding:

`src/reconciliation/ordering-dimension.ts:116` and `:121` in `resolveToleranceMs()` use `>= 0`, which accepts `0` as a valid tolerance override. Per the Batch 11b brief Scope §1c (`tolerance_ms = Number.parseInt(...) || 5000`), `0` is JS-falsy and should fall back to `DEFAULT_TOLERANCE_MS = 5000`. Current behavior: `VEGA_RECONCILIATION_ORDERING_TOLERANCE_MS=0` makes the dim stricter than spec — any sub-5s drift fails — which can false-fail normal operation.

Reviewer's runtime repro: a 1200 ms drift returns `pass` with env unset (correctly uses default 5000) but returns `fail` when env is set to `0` (bug).

Contrast with `semantic-dimension.ts:121` which correctly uses `> 0` as the fallback boundary.

## Scope

### 1. `src/reconciliation/ordering-dimension.ts`
Change two occurrences in `resolveToleranceMs()`:
- Line 116: `typeof value === "number" && Number.isInteger(value) && value >= 0` → `value > 0`
- Line 121: `Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_TOLERANCE_MS` → `parsed > 0 ? parsed : DEFAULT_TOLERANCE_MS`

This aligns with `semantic-dimension.ts` pattern and the brief's `|| 5000` semantic.

### 2. `src/tests/reconciliation-ordering.test.ts`
Add at least 3 new test cases covering the fallback contract:
- **env = "0"** → tolerance resolves to 5000 (a 1200ms drift memory returns `pass` at overall dim level — assert exact)
- **env = "-500"** → tolerance resolves to 5000
- **arg = 0 passed via `runOrderingDimension({..., tolerance_ms: 0})`** → tolerance resolves to 5000

Keep existing tests untouched.

### 3. Optional defensive coverage (recommended, not required)
If low-cost, add 1-2 analogous fallback tests in `src/tests/reconciliation-semantic.test.ts` to lock the already-correct `> 0` behavior there against future drift. Not strictly required for this batch.

## Out of scope — do NOT touch
- `src/reconciliation/semantic-dimension.ts` (already correct; no code change)
- `src/reconciliation/shape-dimension.ts`
- `src/reconciliation/orchestrator.ts` (11b wiring unchanged)
- 11a sealed files (count-dimension.ts / findings-store.ts / retention.ts / report.ts / index.ts)
- 10a metrics stack
- `dashboards/` / `src/scheduler/` / `src/notify/` / `src/db/migrations/` / `src/core/contracts/` / `src/api/server.ts` / `src/mcp/server.ts`
- 10a.1 revert-locked files

## Forbidden files
- All prior Out-of-scope files
- `src/reconciliation/semantic-dimension.ts` / `shape-dimension.ts` / `orchestrator.ts` / `count-dimension.ts` / `findings-store.ts` / `retention.ts` / `report.ts` / `index.ts` (unchanged)
- Existing `src/tests/reconciliation-shape.test.ts` / `reconciliation-count.test.ts` / `reconciliation-mcp.test.ts` / `reconciliation-retention.test.ts` (unchanged)
- `docs/**` except this brief
- Root-level markdown files

## Forbidden patterns (Wave 5 全程继续)
- Production 代码不得嗅探测试环境
- 测试不得触碰 macOS 真实钥匙串 / 真实 HOME / 真实 user config
- 不 amend existing commits

## Acceptance criteria
1. `grep -nE '>= 0' src/reconciliation/ordering-dimension.ts` 返回空（原两处 `>= 0` 已全部改为 `> 0`）
2. `grep -nE 'parsed > 0|value > 0' src/reconciliation/ordering-dimension.ts` 至少 2 处命中
3. `src/tests/reconciliation-ordering.test.ts` 新增至少 3 个 test case 覆盖：env="0"、env="-500"、arg=0 各触发 fallback 到 5000；断言通过 1200ms drift 的 memory 在每种场景下返 pass
4. `git diff HEAD -- src/reconciliation/` 仅涉及 `ordering-dimension.ts`，其他 reconciliation 文件零变动
5. `git diff HEAD -- src/tests/` 仅涉及 `reconciliation-ordering.test.ts`（optional: + `reconciliation-semantic.test.ts` 防御性 tests），其他 test 文件零变动
6. `git diff HEAD -- src/monitoring/ dashboards/ src/scheduler/ src/notify/ src/db/migrations/ src/core/contracts/ src/api/server.ts src/mcp/server.ts` 全部为空
7. `npm run build` 成功退出；`npm test` 全绿（预期 ≥ 1039 pass，因至少 3 条新测试 + 可选 1-2 条防御性测试）
8. 严格**不 amend** commit `fab12d6`，新起 commit 在其上
9. Commit title 前缀 `fix(reconciliation):`
10. Commit body：
    ```
    Closes Round-1 review finding on fab12d6 (Batch 11b). ordering-dimension
    resolveToleranceMs() used >= 0 for both the argument and env-var guards,
    which incorrectly accepted 0 as a valid tolerance override. Per brief
    Scope §1c (Number.parseInt(...) || 5000), 0 is JS-falsy and MUST fall
    back to DEFAULT_TOLERANCE_MS = 5000. Tightened both guards to > 0, matching
    semantic-dimension.ts:121.

    Adds regression tests covering env="0" / env="-500" / arg=0 fallback
    paths so a 1200ms drift correctly reports pass under each.

    Scope-risk: none
    Reversibility: clean
    ```

## Review checklist
- `resolveToleranceMs` 两处 `>= 0` 是否都改为 `> 0`？
- 测试是否严格断言 overall dim level `status === "pass"`（不是 `!= "fail"` 这种弱断言）？
- 除 ordering-dimension.ts + ordering test + 可选 semantic test 外是否零变动？
- 新 commit 是否叠 `fab12d6` 下方（`git log --oneline -2`），不 amend？

## Commit discipline
- 单 atomic commit，新起
- 前缀 `fix(reconciliation):`
- body 按 Acceptance #10
- 不创建 markdown / root-level 文档
