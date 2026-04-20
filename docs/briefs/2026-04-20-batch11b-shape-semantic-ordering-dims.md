# Batch 11b — Reconciliation Shape + Semantic (α) + Ordering dimensions

## Context
11a/11a.1 (commits `fc52ad7`, `55a0ddd`) sealed the reconciliation foundation: Count dimension + MCP tool `reconciliation.run` + findings-store + retention with current-run protection. Orchestrator currently dispatches Count with real logic and stubs Shape / Semantic / Ordering / Derived as `status: "not_implemented"`.

This batch (11b) replaces 3 of those stubs with real implementations. Derived stays `not_implemented` (Q4 α from pre-batch planning: Wave 6 deferred). Aggregate 11c Tests remain deferred.

Deferred follow-ups already tracked:
- GitHub #43: scheduler auto-trigger
- GitHub #44: NotificationManager alert wiring
- GitHub #45: Wave 6 enum canonicalization

## Scope

### 1. Three new dimension modules
Each module follows the same shape as `src/reconciliation/count-dimension.ts` (look to it as reference; do NOT modify it). Each exports a `runXxxDimension(...)` function returning findings array + overall `DimensionStatus` (pass / fail / error).

#### 1a. `src/reconciliation/shape-dimension.ts`
**What it checks**: field-structure parity between `memories` rows and their corresponding `raw_inbox` envelope (`payload_json`) for the invariant field set only.

**Invariant field set** (hardcoded in module as `SHAPE_INVARIANT_FIELDS` const):
- `content`
- `type`
- `source_kind`
- `event_type`
- `project`

**Explicitly excluded**: `access_count`, `accessed_at`, `updated_at`, `embedding`, `importance`, `source_context` (mutable / orthogonal to shadow write correctness).

**Algorithm**:
- For each memory in window joined to raw_inbox via `event_id = memory.id`:
  - Decode `raw_inbox.payload_json` as JSON
  - For each field in SHAPE_INVARIANT_FIELDS:
    - If missing from either side → emit finding `{ event_type, mismatch_type: "field_missing", field_name, sample_ids }`
    - If present both sides but values differ → emit finding `{ event_type, mismatch_type: "value_mismatch", field_name, sample_ids }`
- Sample IDs capped at 10 per finding row (same pattern as count-dimension)
- Overall status: `pass` if zero findings, `fail` if any finding, `error` if module throws (caught by orchestrator)

#### 1b. `src/reconciliation/semantic-dimension.ts`
**α path**: content-hash sampling only. **NO embedding classifier** (brief-level constraint; Wave 6 可另起).

**Algorithm**:
- Resolve `k = Number.parseInt(process.env.VEGA_RECONCILIATION_SEMANTIC_SAMPLE_SIZE) || 50`
- Random-sample `min(k, memories_in_window_count)` memories from window
- For each sampled memory: fetch paired raw_inbox envelope via `event_id`
- Compute `sha256(memory.content)` vs `sha256(envelope.payload.content)` (or the equivalent content field — follow shadow-writer / memory-to-envelope mapping to locate the content path within payload_json)
- If hashes differ → emit finding `{ event_type, mismatch_type: "content_hash_mismatch", sample_ids: [event_id], snippet: first 100 chars of each side truncated }` (cap 10 per finding row)
- **Config path**: env var OR MCP tool param `semantic_sample_size` if the user wants per-run override (optional; if skipped, env is source of truth)
- Overall status: `pass` if zero hash mismatches, `fail` if any, `error` on throw
- Handle `payload_json` parse errors gracefully: log warn, count as `error` status with details

#### 1c. `src/reconciliation/ordering-dimension.ts`
**What it checks**: timestamp alignment between shadow write and main write, with a symmetric tolerance window.

**Algorithm**:
- Resolve `tolerance_ms = Number.parseInt(process.env.VEGA_RECONCILIATION_ORDERING_TOLERANCE_MS) || 5000`
- For each memory in window joined to raw_inbox via `event_id = memory.id`:
  - Compute `delta_ms = Math.abs(epoch_ms(raw_inbox.received_at) - epoch_ms(memories.created_at))`
  - If `delta_ms > tolerance_ms` → emit finding `{ event_type, mismatch_type: "timestamp_drift", sample_ids: [event_id], delta_ms }`
- **Do NOT** assert a directional invariant (e.g., `shadow >= main`). Rationale: `memories.created_at` is business time, `raw_inbox.received_at` is shadow-landing time; clock skew, TX commit ordering, and TEXT-precision edge cases make a strict single-direction comparison brittle. Symmetric ±tolerance window is the stable check.
- Sample IDs capped at 10 per finding
- Overall status: `pass` / `fail` / `error` per same convention

### 2. Orchestrator dispatch change — `src/reconciliation/orchestrator.ts`
Replace the 3 stub branches (shape / semantic / ordering) with imports + calls. Wrap each in try/catch so one dim throwing doesn't abort the run:
```ts
const runDimension = async (dim: DimensionName, fn: () => DimensionResult): Promise<DimensionResult> => {
  try {
    return await fn();
  } catch (err) {
    return {
      dimension: dim,
      status: "error",
      findings: [],
      error: err instanceof Error ? err.message : String(err)
    };
  }
};
```
(The exact code shape is codex's call — key invariant is per-dimension try/catch, NOT a single try/catch around the whole dispatch loop.)

Derived dim stub remains unchanged (`not_implemented`). Count dim wiring remains unchanged.

### 3. Tests
- `src/tests/reconciliation-shape.test.ts`: missing field detected / value mismatch detected / matched shape returns pass / invariant fields only (excluded fields like access_count ignored even if they differ) / sample cap 10 / error status on payload_json parse failure
- `src/tests/reconciliation-semantic.test.ts`: hash match returns pass / hash mismatch detected / env-based k=1 respected / MCP tool param override works (if that path is implemented) / sample cap 10 / payload parse failure → status=error
- `src/tests/reconciliation-ordering.test.ts`: delta within tolerance → pass / delta above tolerance → fail with correct delta_ms value / env tolerance_ms override respected / directional symmetry (positive and negative deltas both detected beyond tolerance) / sample cap 10

Existing orchestrator / count / retention / mcp / fingerprint / runtime / collector tests **must stay green**.

## Out of scope — do NOT touch
- `src/reconciliation/count-dimension.ts` (11a seal, byte-identical)
- `src/reconciliation/findings-store.ts` / `retention.ts` / `report.ts` / `index.ts` (11a seal)
- Derived dim logic (Wave 6)
- 11c aggregate tests (separate batch)
- Scheduler auto-trigger (GitHub #43)
- NotificationManager wiring (GitHub #44)
- `vega_shadow_replay_lag_seconds` histogram metric wiring (defer until scheduler hooks land)
- 10a metrics stack (`src/monitoring/vega-metrics.ts` / `metrics.ts` / `metrics-fingerprint.ts`) — byte-locked
- `dashboards/vega-runtime-core.json`
- 10a.1 revert-locked files

## Forbidden files
- `src/monitoring/**`
- `dashboards/**`
- `src/scheduler/**`
- `src/notify/**`
- `src/db/migrations/**`
- `src/core/contracts/**`
- `src/api/server.ts` / `src/mcp/server.ts` (wiring unchanged; no new env vars exposed except the two listed in Scope which are read directly by dim modules)
- `src/reconciliation/count-dimension.ts` / `findings-store.ts` / `retention.ts` / `report.ts` / `index.ts` (seal)
- Existing `src/tests/**.ts` files (only new reconciliation-shape / semantic / ordering test files allowed)
- `docs/**` except this brief
- Root-level markdown files
- This brief itself

## Forbidden patterns (Wave 5 全程继续)
- Production 代码不得嗅探测试环境 (`isNodeTestEnvironment` / `process.execArgv` / `NODE_ENV === "test"`)
- 测试不得触碰 macOS 真实钥匙串 / 真实 HOME / 真实 user config
- 隔离只能靠 DI / 参数注入 / mock
- dim 模块不得 import `vega-metrics.ts` (metric emit 另一批次处理)
- Ordering dim 不得写成 `shadow >= main` 单向硬不变式 —— 必须对称 tolerance
- Semantic dim 不得引入 embedding / classifier 依赖 (α path 限制)

## Known limitations (必须在 commit body 里复述)
1. **Derived dim 仍是 stub** (`not_implemented`)；Wave 6 独立 parent 处理
2. **Semantic 仅 α 路径**：content-hash 采样，未接 embedding classifier；false-negative (语义等价但 hash 不同) 需人工 spot-check via findings 表
3. **Ordering 用对称 ±tolerance 窗口**（默认 ±5s），不假设 shadow/main 的时序方向。理由：`memories.created_at` 是业务时间，`raw_inbox.received_at` 是 shadow 落盘时间，时钟 / TX 提交顺序 / TEXT 精度使单向硬不变式过于脆
4. **Shape 只比 invariant fields**（content / type / source_kind / event_type / project），其他可变字段（access_count / accessed_at / updated_at / embedding / importance / source_context）不参与 diff
5. **Dim 间错误隔离**：一维 throw 不影响其他维度；error dim 单独记 status=error + message，orchestrator 继续跑完
6. **SQLite-only**（继承 11a 约束）
7. **未接 metric emit**：`vega_reconciliation_*` 系列延到 scheduler 批次（GitHub #43）

## Acceptance criteria
1. `src/reconciliation/shape-dimension.ts` / `semantic-dimension.ts` / `ordering-dimension.ts` 三个新文件存在
2. `grep -nE 'SHAPE_INVARIANT_FIELDS' src/reconciliation/shape-dimension.ts` 命中声明行；内容覆盖 content / type / source_kind / event_type / project 且不含 access_count / accessed_at / updated_at / embedding / importance / source_context
3. `grep -nE 'VEGA_RECONCILIATION_SEMANTIC_SAMPLE_SIZE' src/reconciliation/semantic-dimension.ts` 命中
4. `grep -nE 'VEGA_RECONCILIATION_ORDERING_TOLERANCE_MS' src/reconciliation/ordering-dimension.ts` 命中
5. `grep -nE 'Math\.abs|abs\s*\(' src/reconciliation/ordering-dimension.ts` 命中（对称 tolerance 用绝对值）
6. `grep -nE 'received_at >=|received_at <=|created_at >=|created_at <=' src/reconciliation/ordering-dimension.ts` 返回空（不得有单向不变式比较）
7. `grep -nE 'import.*vega-metrics|from.*vega-metrics' src/reconciliation/` 递归返回空（dim 模块不得 import metric 层）
8. `grep -nE 'embedding|classifier|cosine' src/reconciliation/semantic-dimension.ts` 返回空（α path 无 embedding 依赖）
9. `orchestrator.ts` 中 shape / semantic / ordering 的 `not_implemented` 字面量被替换为真实 dispatch；Derived 仍 `not_implemented`
10. per-dimension try/catch 隔离落实：orchestrator 某 dim 抛错时其他 dim 仍完成（至少 1 条测试覆盖此行为，可放入某个 dim 测试或单独 fixture）
11. `npm run build` 成功退出；`npm test` 全绿（具体测试数不做死约束）
12. `git diff HEAD -- src/reconciliation/count-dimension.ts src/reconciliation/findings-store.ts src/reconciliation/retention.ts src/reconciliation/report.ts src/reconciliation/index.ts` 输出为空（11a seal）
13. `git diff HEAD -- src/monitoring/ dashboards/ src/scheduler/ src/notify/ src/db/migrations/ src/core/contracts/ src/api/server.ts src/mcp/server.ts` 输出为空
14. 现有 `src/tests/**.ts` 文件**零修改**；仅新增 reconciliation-shape / semantic / ordering 三个测试文件
15. 严格**不 amend** commit `55a0ddd`，新起 commit 在其上
16. Commit title 前缀 `feat(reconciliation):`
17. Commit body 必须包含 `Closes P8-032.2, P8-032.3, P8-032.4` 和原样复述上面 7 条 Known limitations

## Review checklist
- 三个 dim 模块的 `runXxxDimension` 函数签名是否与 count-dimension.ts 同风格（orchestrator 可等价替换）？
- Shape 的 invariant fields 硬编码是否正好 5 条，未多未少？
- Semantic env var 默认 k=50，Number.parseInt 非法输入 fallback 到 50 而非抛错？
- Ordering tolerance 默认 5000 ms，Number.parseInt 非法输入 fallback 到 5000？
- Ordering 绝对值计算是否正确（Math.abs on epoch delta）？
- 每个 dim 的 sample_ids 是否都上限 10 条？
- orchestrator try/catch 是否 per-dim（不是整体 try/catch）？
- Derived dim 是否仍 `not_implemented`（未被误触）？
- 有没有误 import vega-metrics 或其他 metric 层？
- Ordering 有没有残留 `>=` / `<=` 单向比较？
- Known limitations 7 条是否原样落进 commit body？

## Commit discipline
- 单 atomic commit，新起，不 amend `55a0ddd`
- 前缀 `feat(reconciliation):`
- body 按 Acceptance #17
- 不创建 markdown / root-level 文档
- 不修改现有测试文件
