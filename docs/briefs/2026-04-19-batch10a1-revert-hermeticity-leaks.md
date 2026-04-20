# Batch 10a.1 — Revert test-hermeticity leaks + rework metrics-api test + tighten raw_inbox SQL + move nonempty emit

## Problem
Commit `7692b92`（Batch 10a）把测试隔离逻辑写进了 4 个 production 文件：
- `src/config.ts` — `isNodeTestEnvironment()` + `loadFileConfig` gate
- `src/security/keychain.ts` — `isNodeTestEnvironment()` + `keychainTouchedInProcess` latch
- `src/core/integration-surface-status.ts` — `isHomeOverrideActive()` + `collectActivityRecords` gate
- `src/cli/commands/doctor.ts` — `isHomeOverrideActive()` + `buildIntegrationSurfaceStatuses` gate

**根因**：`src/tests/metrics-api.test.ts` boot 完整 `createAPIServer()`，启动链读真实 `~/.vega/config.json` / macOS 钥匙串 / `~/.cursor|.codex|.claude` 目录。

此外 Batch 10a 还遗留两处需 tighten：
- `vega_raw_inbox_oldest_age_seconds` 空表语义未在 brief 中写清
- `vega_retrieval_nonempty_total` emit 点位置可能不覆盖 cache hit / error path

## Scope
1. **Revert** 上面 4 个文件到 `7692b92^` 状态（完全回到 Batch 10a 之前的内容）
2. **Rework** `src/tests/metrics-api.test.ts`：不再 call `createAPIServer`，改走 handler-level —— 直接实例化 `MetricsCollector` + `createVegaMetrics`，断言 `await collector.getMetrics()` 的 HELP/TYPE 行覆盖 8 个 vega_* metric families
3. **保留不变**：`src/monitoring/metrics.ts` / `src/api/server.ts` / `src/retrieval/circuit-breaker.ts` / `src/usage/usage-ack-handler.ts` —— emit wiring 不碰
4. **保留不变**：`src/tests/metrics-runtime.test.ts` / `src/tests/metrics-collector.test.ts` —— 这两个已是 unit-level，不改
5. **收紧** `vega_raw_inbox_oldest_age_seconds` / `vega_raw_inbox_rows` 空表语义：`src/monitoring/vega-metrics.ts` 的 gauge callback SQL 查询**必须显式处理 MIN(received_at) IS NULL 场景 —— 跳过该 label series，不 emit `= 0` 行，不 emit null / NaN 行**。仅为"实际出现过且 COUNT(*) > 0 的 event_type"emit series
6. **移动** `vega_retrieval_nonempty_total` 的 emit 点：从当前 orchestrator 内部位置移到**最终 response 对象构造完成之后**（所有 return branch 汇聚前的最后一道）。必须覆盖 normal path / cache hit path（若存在）/ error path 三条；`bundle_digest === "error"` 时仍然不 inc；若 orchestrator 没有显式 cache path，在 commit body 注明 "no cache path exists, coverage verified"

## Forbidden patterns（Wave 5 全程生效）
- **Production 代码不得嗅探测试环境**：严禁 `process.execArgv.some(--test)` / `process.env.NODE_ENV === "test"` / `isNodeTestEnvironment()` / 类似 runtime flag
- **Production 代码不得分支走"只在测试生效"的路径**
- **测试若需隔离，必须走 DI / 参数注入 / mock / 构造函数传入，不得改 production**

## Forbidden files
- `src/monitoring/metrics.ts`（不改）
- `src/monitoring/vega-metrics.ts`（**仅** Scope #5 所要求的 gauge callback SQL 空表处理允许改动，且仅限 SQL / null 判断，不得新增 label / 新增 metric / 改业务逻辑 / 改其他 emit 方法）
- `src/api/server.ts`（上一锅注入已正确，不改）
- `src/retrieval/orchestrator.ts`（**仅** Scope #6 所要求的 `vega_retrieval_nonempty_total` emit 位置移动允许改动；仅限位置调整，不得改 emit 条件 / 不得改其他业务逻辑）
- `src/retrieval/circuit-breaker.ts` / `src/usage/usage-ack-handler.ts`（emit wiring 完全不改）
- `src/tests/metrics-runtime.test.ts` / `src/tests/metrics-collector.test.ts`（不改）
- 其他 Batch 10a Forbidden files 列表继续适用（DB schema / contracts / docs / root-level markdown）
- 本 brief 本身
- `current-status.md` / `next-step.md` / `ROADMAP.md` / `EXECUTION_PLAN.md` / `PHASE4_VISION.md` 一律不新增或修改

## Acceptance criteria
1. `git diff 7692b92^..HEAD -- src/config.ts src/security/keychain.ts src/core/integration-surface-status.ts src/cli/commands/doctor.ts` 输出为空（四个文件彻底回退）
2. `npm run build` + `npm test` 全绿（996 pre-existing + 本批次保留的 metrics-runtime / metrics-collector 测试 + 改写后的 metrics-api 测试 + Scope #5/#6 新增的 2 条测试）
3. `src/tests/metrics-api.test.ts` 里**不出现** `createAPIServer` 的 import 或调用；不出现 `mkdtempSync` / `tmpdir`；不出现 `process.env.HOME` 操作
4. 改写后的 metrics-api 测试仍覆盖 8 个 vega_* metric families 的 HELP/TYPE 行断言
5. **不得 amend** commit `7692b92`，必须在其上新起 commit
6. 新 commit title 前缀 `fix(monitoring):`，body 明写：
   ```
   Reverts test-hermeticity leaks from 7692b92 in config, keychain,
   integration-surface-status, and doctor.ts. Reworks metrics-api.test.ts
   to assert directly against MetricsCollector.getMetrics() instead of
   booting createAPIServer, eliminating the need for production-side
   test-environment gates.

   Also tightens raw_inbox gauge SQL to skip null MIN(received_at), and
   moves vega_retrieval_nonempty_total emit to the post-response-construction
   join point for normal / cache-hit / error path coverage.

   Scope-risk: low
   Reversibility: clean
   ```
7. `vega_raw_inbox_oldest_age_seconds` 在 raw_inbox 完全空表时**不出现任何 series line**（`rendered` 中断言不含 `vega_raw_inbox_oldest_age_seconds{` 这个前缀的行）；`vega_raw_inbox_rows` 同此语义：不存在的 event_type 不显式 emit 0
8. `vega_retrieval_nonempty_total` 的 emit 位于 orchestrator 最终 response 构造之后；断言覆盖：normal path（records ≥ 1 → inc）/ error path（bundle_digest === "error" → 不 inc）/ empty sections path（records == 0 → 不 inc）。若 orchestrator 实现中存在 cache hit 分支，也须经过同一 emit 点
9. **新增 2 条测试**（可放在 metrics-runtime.test.ts 或新建 metrics-edge.test.ts）：
   - `raw_inbox_empty_table_skips_series` — 空 DB 下 `collector.getMetrics()` 输出中不含 `vega_raw_inbox_oldest_age_seconds{` / `vega_raw_inbox_rows{` 任一 label line
   - `retrieval_nonempty_not_incremented_on_error_path` — 构造一个 error bundle (bundle_digest === "error")，断言 `vega_retrieval_nonempty_total` counter 保持 0

## Reference rework shape — metrics-api.test.ts（codex 可微调）
```ts
import assert from "node:assert/strict";
import test from "node:test";
import { MetricsCollector } from "../monitoring/metrics.js";
import { createVegaMetrics } from "../monitoring/vega-metrics.js";
import { Repository } from "../db/repository.js";

test("Batch 10a metric families registered with HELP and TYPE lines", async () => {
  const db = new Repository(":memory:");
  try {
    const collector = new MetricsCollector({ enabled: true, prefix: "vega" });
    createVegaMetrics(collector, db);
    const rendered = await collector.getMetrics();

    for (const [name, type] of [
      ["vega_retrieval_calls_total", "counter"],
      ["vega_retrieval_nonempty_total", "counter"],
      ["vega_usage_ack_total", "counter"],
      ["vega_usage_followup_loop_override_total", "counter"],
      ["vega_circuit_breaker_state", "gauge"],
      ["vega_circuit_breaker_trips_total", "counter"],
      ["vega_raw_inbox_rows", "gauge"],
      ["vega_raw_inbox_oldest_age_seconds", "gauge"]
    ] as const) {
      assert.match(rendered, new RegExp(`# HELP ${name} `));
      assert.match(rendered, new RegExp(`# TYPE ${name} ${type}`));
    }
  } finally {
    db.close();
  }
});
```

## Review checklist
- 4 个 production 文件的 diff vs `7692b92^` 是否为空？
- metrics-api.test.ts 里有没有残留的 `createAPIServer` / `mkdtempSync` / `process.env.HOME`？
- 新 commit 是不是 `7692b92` 的下一代（`git log --oneline -2`），而不是 amend 了它？
- 其余 10a 功能（8 个 metric family 仍正常渲染）是否 byte-identical（抽查 HELP 文本）？
- `vega-metrics.ts` 的 SQL 改动是否仅限空表 null 处理，没有波及其他 query / metric / 方法？
- `orchestrator.ts` 的 emit 点位移动是否仅改位置，没有改 emit 条件 / 业务逻辑？
- 有没有意外碰了 Forbidden files 里列的其他文件？
- Forbidden patterns 是否严格遵守：production 代码里 `process.execArgv` / `NODE_ENV === "test"` / `isNodeTestEnvironment` / 相关测试嗅探全部消失？

## Commit discipline
- 单 atomic commit，新起，不 amend
- 前缀 `fix(monitoring):`
- body 按 Acceptance #6 格式（含 Scope #5/#6 的追加说明）
- 不创建 markdown / root-level 文档
