# Batch 11a — Reconciliation foundation: Count + MCP tool + findings-store

## Context
10a stack sealed P8-034 Dashboard Core 5（commits `7692b92..eb4fb35`）. Phase 8 shadow dual-write (Wave 3, flag `VEGA_SHADOW_DUAL_WRITE`) writes every memory insert to `raw_inbox` in parallel to main tables — **best-effort, not transactional**: shadow failures are logged but main commits regardless. That means raw_inbox can miss envelopes; reconciliation is how we catch it.

P8-032 Reconciliation 5-dimensional matrix (Count / Shape / Semantic / Ordering / Derived) is Wave 5 Group F Ops foundational. This batch (11a) ships the end-to-end foundation with **only Count dimension fully implemented**. Shape / Semantic / Ordering are stubs returning `not_implemented`. Derived is deferred to Wave 6 (Q4 α).

Deferred follow-ups already tracked:
- GitHub #43: scheduler auto-trigger
- GitHub #44: NotificationManager alert wiring
- GitHub #45: Wave 6 enum canonicalization

## Scope

### 1. New directory `src/reconciliation/`
- `src/reconciliation/findings-store.ts` — SQLite-only findings table + migration + CRUD API
- `src/reconciliation/count-dimension.ts` — Count logic (shadow-write miss + orphan envelope detection)
- `src/reconciliation/orchestrator.ts` — orchestrates 5-dimensional run; only Count is live, others return `{ status: "not_implemented" }` stubs
- `src/reconciliation/report.ts` — formats `ReconciliationReport` output struct
- `src/reconciliation/retention.ts` — prune findings per retention policy
- `src/reconciliation/index.ts` — re-exports public API

### 2. SQLite migration: `reconciliation_findings`
Schema:
```sql
CREATE TABLE IF NOT EXISTS reconciliation_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  dimension TEXT NOT NULL CHECK (dimension IN ('count','shape','semantic','ordering','derived')),
  status TEXT NOT NULL CHECK (status IN ('pass','fail','not_implemented','error')),
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  event_type TEXT,
  direction TEXT CHECK (direction IN ('forward','reverse') OR direction IS NULL),
  expected INTEGER,
  actual INTEGER,
  mismatch_count INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reconciliation_findings_run_idx ON reconciliation_findings (run_id);
CREATE INDEX IF NOT EXISTS reconciliation_findings_dim_idx ON reconciliation_findings (dimension, created_at);
CREATE INDEX IF NOT EXISTS reconciliation_findings_created_idx ON reconciliation_findings (created_at);
```
Migration pattern: additive like `applyRawInboxMigration` (PRAGMA table_info + ALTER TABLE ADD COLUMN for future fields). Called at startup in `src/api/server.ts` next to existing migrations.

### 3. Count dimension logic (bi-directional)
For window `[window_start, window_end)` (epoch ms):

**Forward pass** — "did shadow drop any main writes?"
- `expected` = count of memories whose `created_at` falls in window, with `source IN ('explicit','candidate_promotion')` (these are the source types that shadow-aware-repository intercepts)
- `actual` = count of memories from that set that have a matching `raw_inbox.event_id = memory.id`
- `mismatch_count` = `expected - actual` (non-negative; negative clamped to 0 and logged as anomaly)
- `status` = `pass` if `mismatch_count === 0`, `fail` otherwise
- emit per `event_type` finding row (decision / state_change)

**Reverse pass** — "orphan envelopes with no main row?"
- `expected` = count of `raw_inbox` rows in window where `event_type IN ('decision','state_change')`
- `actual` = count of those whose `event_id` exists in `memories.id`
- `mismatch_count` = `expected - actual`
- `status` = `pass` if `mismatch_count === 0`, `fail` otherwise
- emit per `event_type` finding row

Payload JSON must include sample mismatched IDs (cap 10 per finding) so operators can drill in.

### 4. `ReconciliationOrchestrator`
- Public API: `run({ window_start, window_end, dimensions? }): Promise<ReconciliationReport>`
- Default dimensions = all 5 (count + 4 stubs)
- Generates `run_id` (UUID v4)
- For each dimension: execute, persist findings, collect into report
- Prune findings **after** insertion (so current run is always preserved)
- Return report struct (see §5)

### 5. Report shape (contract)
```ts
// src/reconciliation/report.ts
export interface ReconciliationReport {
  schema_version: "1.0";
  run_id: string;
  window_start: number;
  window_end: number;
  dimensions: ReconciliationDimensionReport[];
  totals: {
    pass: number;
    fail: number;
    not_implemented: number;
    error: number;
  };
  generated_at: number;
}
export interface ReconciliationDimensionReport {
  dimension: "count" | "shape" | "semantic" | "ordering" | "derived";
  status: "pass" | "fail" | "not_implemented" | "error";
  findings: ReconciliationFindingSummary[];
  error?: string; // present only when status === "error"
}
export interface ReconciliationFindingSummary {
  event_type?: string;
  direction?: "forward" | "reverse";
  expected?: number;
  actual?: number;
  mismatch_count: number;
  sample_ids?: string[];
}
```

### 6. MCP tool `reconciliation.run`
Register in `src/mcp/server.ts` alongside existing tools (usage.ack / candidate.* / circuit_breaker.*).
- Input schema (zod):
  - `window_start` (number, optional, default = `now - 24h`)
  - `window_end` (number, optional, default = `now`)
  - `dimensions` (enum array, optional, default = all 5)
- Invoke: calls `ReconciliationOrchestrator.run(...)`, returns `ReconciliationReport`
- Postgres path: return `{ schema_version: "1.0", degraded: "sqlite_only" }` — don't crash

### 7. Retention
- `pruneFindings({ retention_days, retention_max_rows })`:
  - Delete rows where `created_at < now - retention_days * 86_400_000`
  - If row count still exceeds `retention_max_rows`, delete oldest rows until within limit
- Env vars:
  - `VEGA_RECONCILIATION_RETENTION_DAYS` (default 30)
  - `VEGA_RECONCILIATION_RETENTION_MAX_ROWS` (default 10000)
- Called at end of every `run()` (after findings inserted)

### 8. Tests
- `src/tests/reconciliation-count.test.ts`: forward miss detected / reverse orphan detected / zero mismatches / empty window / payload sample IDs capped at 10
- `src/tests/reconciliation-orchestrator.test.ts`: orchestrator returns `not_implemented` for 3 stubs + Derived absent unless explicitly requested; report totals arithmetic correct; retention runs after persistence
- `src/tests/reconciliation-mcp.test.ts`: MCP tool registration + Postgres `degraded: "sqlite_only"` path + input validation
- All tests hermetic: `:memory:` DB, no HOME / keychain / user config touches

## Out of scope — do NOT touch
- Shape / Semantic / Ordering actual logic (11b territory)
- Derived dimension (Wave 6)
- Scheduler auto-trigger (GitHub #43 — defer)
- NotificationManager wiring (GitHub #44 — defer)
- `VEGA_RECONCILIATION_ENABLED` feature flag (not needed; tool callable on demand)
- Wiring `vega_shadow_replay_lag_seconds` histogram (defer to when Scheduler is in)
- CLI `vega reconcile` command (defer to 11b unless trivially wired)
- 10a metrics stack bytes: `src/monitoring/vega-metrics.ts` / `metrics.ts` / `metrics-fingerprint.ts` (byte-locked)
- `dashboards/vega-runtime-core.json` (no change)
- 10a.1 revert-locked files (`src/config.ts` / `src/security/keychain.ts` / `src/core/integration-surface-status.ts` / `src/cli/commands/doctor.ts`)

## Forbidden files
- All prior batch Out of scope (inherited; 10a + 10a.1-.4 + 10b + 10b.1)
- `src/monitoring/**` (byte-locked)
- `dashboards/**`
- `src/scheduler/**` (no scheduler hook this batch)
- `src/notify/**` (no notification wiring)
- `src/db/migrations/**` (migration lives in `src/reconciliation/findings-store.ts` per existing pattern)
- `src/core/contracts/**` (no contract additions — `ReconciliationReport` types live in `src/reconciliation/`, not contracts/)
- Existing `src/tests/**` files unchanged; only new `src/tests/reconciliation-*.test.ts` allowed
- `docs/**` except this brief; no new markdown
- `current-status.md` / `next-step.md` / `ROADMAP.md` / `EXECUTION_PLAN.md` / `PHASE4_VISION.md` — unchanged
- This brief itself

## Forbidden patterns (Wave 5 全程继续)
- Production 代码不得嗅探测试环境（`isNodeTestEnvironment` / `process.execArgv` / `NODE_ENV === "test"`）
- 测试不得触碰 macOS 真实钥匙串 / 真实 HOME / 真实 user config
- 测试隔离必须走 DI / 参数注入 / mock
- findings-store SQL 不得写成实现细节（遵循 10b.1 原则：注释描述"查询什么"，不写代码符号）

## Known limitations (必须在 commit body 里复述)
1. **仅 Count dimension 实现**；Shape / Semantic / Ordering 留 `not_implemented` stub，由 11b 填。Derived 延 Wave 6
2. **仅 CLI/MCP 按需触发**，未接 scheduler（GitHub #43）
3. **未接 NotificationManager**（GitHub #44）
4. **SQLite-only**；Postgres path 返回 `degraded: "sqlite_only"`
5. **Backup / restore 路径未审视**：当前不知道 restore 是否走 shadow-aware 层；reconciliation 可能把 restore 场景误判为 mismatch。未来需单独审 + 加 restore 通道标记
6. **Shadow dual-write 非事务性**：shadow 失败时 main 仍 commit。Count 的 forward miss 正是用来度量这个比率 —— 这不是 bug 而是 by-design；运维需理解 "mismatch > 0" 不一定是 reconciliation 自身的错
7. **Event type filter 硬编码为 `decision` / `state_change`**：若未来 shadow-aware-repository 扩展拦截范围，需同步更新 Count dimension 的 event_type filter

## Acceptance criteria
1. `src/reconciliation/` 目录存在，含 6 个 TS 文件（findings-store / count-dimension / orchestrator / report / retention / index）
2. `applyReconciliationFindingsMigration()` 在 `src/api/server.ts` 启动时被调（模仿 `applyRawInboxMigration` 的 wiring 点）
3. `grep -nE "reconciliation_findings" src/reconciliation/findings-store.ts` 找到 CREATE TABLE 语句
4. MCP tool `reconciliation.run` 注册在 `src/mcp/server.ts`
5. Postgres path：`reconciliation.run` 返回 `{ schema_version: "1.0", degraded: "sqlite_only" }`（测试覆盖）
6. Stub dimensions 返回 `status: "not_implemented"`（测试覆盖）
7. Count dimension 正确检测 forward miss + reverse orphan（至少各 1 条测试）
8. Retention 在 findings 插入**之后**执行，测试覆盖两种阈值（天数 + 行数）
9. `npm run build` 成功退出；`npm test` 全绿（具体测试数不做死约束）
10. 新 commit 叠 `eb4fb35`，不 amend
11. Commit title 前缀 `feat(reconciliation):`
12. Commit body 包含 `Closes P8-032.1, P8-032.6, P8-032.8` + 原样复述上面 7 条 Known limitations
13. 其他 Forbidden files 0 字节变动（`git diff HEAD -- src/monitoring/ dashboards/ src/scheduler/ src/notify/ src/db/migrations/ src/core/contracts/` 全部为空）
14. 本批次只可新增测试文件，不得修改现有 `src/tests/**.ts`

## Review checklist
- Count dimension 的 forward / reverse 两 pass 是否都实现？边界条件（空 window / event_type 只在一边）处理对吗？
- `mismatch_count` 负数是否被 clamp + logged 为异常？
- retention 是否**后置**于 findings insertion？
- Postgres path 返回 `degraded` 响应 vs 直接抛错？
- orchestrator 的 stub 返回 `not_implemented` 不是 `pass`（默认等价会掩盖真问题）？
- MCP tool 的 input zod schema 是否校验 `window_start < window_end`？
- 有没有误碰 Forbidden files？
- 新 reconciliation 模块是否**不** import `vega-metrics.ts`（避免和 10a seal 耦合；metrics emit 延后一批处理）？
- Known limitations 7 条是否原样落进代码注释 + commit body？

## Commit discipline
- 单 atomic commit，新起，不 amend
- 前缀 `feat(reconciliation):`
- body 按 Acceptance #12 要求
- 不创建 markdown / root-level 文档（除本 brief 已存在）
- 不修改 `README.md` / `CLAUDE.md` / 任何根目录非代码文件

---

## 4 个内嵌判断点（brief 内 default 已选，你想改就说）

1. **默认 window = 24h**：匹配 daily 节奏；若你想首版更短（比如 1h），告诉我
2. **Retention 默认 30 天 / 10k 行**：保守够用；若你想更激进（比如 7 天 / 5k 行）告诉我
3. **MCP tool name = `reconciliation.run`**：对齐 `usage.ack` / `candidate.*` 命名风格
4. **Findings granularity = per-event_type 一行**（forward/reverse 各一行）：便于 drill-down；aggregate 可由查询时 sum 得到

默认方案都 OK 就 "go"；想改某条告诉我。
