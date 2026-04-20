# Batch 10a — P8-034 Dashboard 核心 5（Part 1: .0 + .1 + .2 + .3）

## Context
Phase 8 Round-8 blueprint，Wave 3 / Wave 4 已交付（checkpoint lifecycle / usage.ack / failure sink / candidate-promoted / circuit breaker）。P8-034 是 Group F 运维的横向基础设施：让运行时 5 个核心指标从"代码里散落的 logger.warn"升级为"可稳定 scrape 的 Prometheus 时序"。本批次只做 P8-034.0 / .1 / .2 / .3；UI 模板（.4）+ 测试文档（.5）归 Batch 10b。

## Scope of this batch
- **P8-034.0** 数据源 + 查询口径（本 brief 已 pin 死，无需再讨论）
- **P8-034.1** Metric 采集中间件（label 化 events）
- **P8-034.2** 核心 5 指标 families 注册
- **P8-034.3** `/metrics` 端点扩展（已存在，只扩展渲染内容）

## Out of scope — do NOT touch
- **P8-034.4** Grafana JSON template → Batch 10b
- **P8-034.5** snapshot tests + label fingerprint 文档 → Batch 10b
- **P8-035** 告警规则 → 独立 parent，本批次不要 pre-wire alert thresholds
- **P8-032** Reconciliation 矩阵 → 独立 parent；`replay_lag` 真正的 histogram 由 P8-032 实现
- 任何 DB schema migration（不允许 ALTER TABLE / 新表）
- 任何 response schema 改动（`/ingest_event` / `/context_resolve` / `/usage_ack` / `/api/phase8_status` 返回值保持字节级不变）

## Forbidden files
- `src/db/migrations/**`（no schema change）
- `src/core/contracts/**`（no contract change — 只 import canonical enum，不新增）
- `src/tests/**` 现有文件**不得修改**；仅可新增 metric 专属测试文件 `src/tests/metrics-*.test.ts`
- `docs/**` 不要创建新文档或修改现有文档（label 字典写代码注释里即可，文档统一放 Batch 10b）
- `current-status.md` / `next-step.md` / `ROADMAP.md` / `EXECUTION_PLAN.md` / `PHASE4_VISION.md` 一律不新增或修改（历史上执行者曾越权创建，此批次禁止）
- 本 brief 本身（`docs/briefs/2026-04-18-batch10a-metrics-core5-part1.md`）不得改动

## Canonical enum imports（不新声明，只复用）
```ts
// src/monitoring/vega-metrics.ts 顶部
import { SURFACES, type Surface } from "../core/contracts/enums.js";
//  SURFACES = ["claude", "codex", "cursor", "opencode", "hermes", "api", "cli"]  ← src/core/contracts/enums.ts:1
import type { CircuitBreakerState, CircuitBreakerTripReason } from "../retrieval/circuit-breaker.js";
//  CircuitBreakerState = "closed" | "open" | "cooldown"                           ← circuit-breaker.ts:4
//  CircuitBreakerTripReason = "low_ack_rate" | "high_followup_rate"               ← circuit-breaker.ts:3

// 本文件新增的 local 枚举（无 canonical 源的，就地声明但保持 as const）
export const RETRIEVAL_INTENTS = ["bootstrap", "lookup", "followup", "evidence"] as const;
//  来源：src/retrieval/profiles.ts:14,24,32,40
export const SUFFICIENCY = ["sufficient", "needs_followup", "needs_external"] as const;
//  来源：src/core/contracts/usage-ack.ts (USAGE_ACK_SCHEMA.sufficiency)
export const HOST_TIER = ["T1", "T2", "T3"] as const;
//  来源：src/core/contracts/usage-ack.ts (USAGE_ACK_SCHEMA.host_tier)
```
若上面 usage-ack.ts 的枚举源与此处声明值不一致，**以 usage-ack.ts 为准**并在 vega-metrics.ts 里注释标明。

## Known limitations — 必须原样写进代码注释 + commit message body

1. **intent 不在 `usage_acks` 表**：ack-handler 可从 `previousCheckpoint` 内存查找拿到 intent，但 checkpoint 过期 / lookup 失败时无法还原。本批次 `vega_usage_ack_*` 系列**不带 intent label**，避免部分 series 缺失造成 dashboard 误导。intent 下沉到 usage_acks 留给未来独立任务。

2. **trace_id 不是端到端**：orchestrator 内部 `createTraceId()` 只在 `context.resolve` 单次调用生命周期内存活，没有随 envelope 跨 ingest → ack 传播。本批次**不把 trace_id 作为 metric label**（高基数风险 + 无法跨请求关联）。后续独立任务处理。

3. **`replay_lag` 留位不填**：现阶段只发两个 scrape-time gauge（`vega_raw_inbox_rows` + `vega_raw_inbox_oldest_age_seconds`）作为"有没有积压"的粗信号。真正的 replay 延迟直方图依赖 P8-032 Reconciliation pipeline 建立；**不要**在本批次先发空 histogram（占位会误导）。

4. **circuit breaker 状态非持久化**：`CircuitBreaker` 是 in-memory per-instance；`vega_circuit_breaker_state` gauge 仅反映当前 process 视角，重启后从 closed 重启。本批次**不改持久化**；gauge HELP 文本必须明写 "per-process, resets on restart"。

5. **retrieval intent vs action 严格分层**：`intent` label 仅用于 retrieval 系列 metric，值域 `RETRIEVAL_INTENTS`（bootstrap/lookup/followup/evidence）。usage/ingest/circuit 系列 **不得引入 intent label** —— 它们是"ack 动作"或"状态变更"而非检索意图。跨类别 correlation 通过 checkpoint_id（非 metric label）实现。

6. **sufficiency_fp_rate 仅为 proxy**：dashboard 上展示的 "sufficiency_fp_rate (proxy)" 来自 `vega_usage_followup_loop_override_total` / `vega_usage_ack_total{sufficiency="needs_followup"}`。底层 metric 刻意不叫 fp_rate，避免与真 FP 指标混淆。HELP 文本明写 "proxy signal for sufficiency false-positive, derived from loop guard override"。

7. **raw_inbox gauge 按 event_type 分组是为了 drill-down**：总积压 / 最大年龄这两个 Wave 5 首发面板**一律在 dashboard 侧用 sum() / max() 聚合**，不在 metric 层再开一份无 label 版本。**`raw_inbox_backlog_total` / `raw_inbox_oldest_age_max` 是 Batch 10b 的 Grafana 面板标题，不是 metric family 名字；本批次严禁以此命名注册任何新 counter / gauge。** 如果未来发现 scrape-time 聚合成本过高才考虑预聚合，本批次不预先做。

## P8-034.0 — 数据源 & 查询口径（spec）

| Metric family | Source | Emit point | Value semantics |
|---|---|---|---|
| `vega_retrieval_calls_total` | retrieval orchestrator | 每次 `context.resolve` 入口（含 error path） | counter inc 1 |
| `vega_retrieval_nonempty_total` | retrieval orchestrator | bundle 非空时：`bundle.sections.some(s => s.records.length > 0)` 为 true 且 `bundle_digest !== "error"` | counter inc 1 |
| `vega_usage_ack_total` | usage-ack-handler | `putResult.status === "inserted"` 分支 | counter inc 1 |
| `vega_usage_followup_loop_override_total` | usage-ack-handler | loop guard `overrideSucceeded === true` 时 | counter inc 1 |
| `vega_circuit_breaker_state` | circuit-breaker | 每次 `transitionTo(state)` 或 breaker 初始化 | gauge set 0/1/2 |
| `vega_circuit_breaker_trips_total` | circuit-breaker | closed → open transition 时，每个 reason 都 emit 一次 | counter inc 1 per reason |
| `vega_raw_inbox_rows` | scrape-time SQL | `MetricsCollector` gauge callback | `SELECT event_type, COUNT(*) FROM raw_inbox GROUP BY event_type` |
| `vega_raw_inbox_oldest_age_seconds` | scrape-time SQL | `MetricsCollector` gauge callback | `SELECT event_type, (now_ms - MIN(epoch(received_at)))/1000 FROM raw_inbox GROUP BY event_type` |

### Dashboard → metric 映射（Batch 10b 才实现，本表仅对齐语义）

**表内左列均为 Grafana 面板标题（UI 层），右列才是 metric / PromQL。本批次不得新增任何 `raw_inbox_backlog_total` / `raw_inbox_oldest_age_max` 等同名 metric family —— 这两者是 Batch 10b 的面板名，聚合在 dashboard 侧完成。**

| 面板标题（panel, UI-only） | PromQL（聚合在 dashboard 侧）|
|---|---|
| coverage (hit rate) | `sum(rate(vega_retrieval_nonempty_total[5m])) / sum(rate(vega_retrieval_calls_total[5m]))` |
| sufficiency_fp_rate (proxy) | `sum(rate(vega_usage_followup_loop_override_total[1h])) / sum(rate(vega_usage_ack_total{sufficiency="needs_followup"}[1h]))` |
| host_tier_dist | `sum by (host_tier) (rate(vega_usage_ack_total[5m]))` |
| circuit_state | `vega_circuit_breaker_state` |
| raw_inbox_age (temp for replay_lag) | `max by (event_type) (vega_raw_inbox_oldest_age_seconds)` |
| raw_inbox_backlog | `sum by (event_type) (vega_raw_inbox_rows)` |
| raw_inbox_backlog_total (default view, panel only) | `sum(vega_raw_inbox_rows)` |
| raw_inbox_oldest_age_max (default view, panel only) | `max(vega_raw_inbox_oldest_age_seconds)` |

## P8-034.1 — Metric 采集中间件（label 化 events）

新建 `src/monitoring/vega-metrics.ts`：

- 导出工厂 `createVegaMetrics(collector: MetricsCollector, db: Database): VegaMetricsRegistry`
- 注册 P8-034.2 列出的 8 个 metric families；返回对象提供**封装好的 emit 方法**，禁止外部直接操作 counter/gauge instance：
  ```ts
  recordRetrievalCall(surface: Surface, intent: RetrievalIntent): void
  recordRetrievalNonempty(surface: Surface, intent: RetrievalIntent): void
  recordUsageAck(surface: Surface, sufficiency: Sufficiency, host_tier: HostTier): void
  recordLoopOverride(surface: Surface): void
  setCircuitState(surface: Surface, state: CircuitBreakerState): void
  recordCircuitTrip(surface: Surface, reason: CircuitBreakerTripReason): void
  ```
- **Gauge scrape-time 回调**：在 registry 构造时通过 `collector.registerGaugeCallback(name, fn)` 或等价机制绑定 raw_inbox 两个 gauge 的实时查询。若 MetricsCollector 尚未提供 callback API，在 `src/monitoring/metrics.ts` 内**最小新增一个** `registerGaugeCollector(name, labels, fn)` 接口（单函数，不改其他行为），并在 `getMetrics()` 渲染前调用它刷新值。
- **未知标签值**：runtime 若收到枚举外的值（例如 surface 收到 `"unknown-host"`），emit 时替换为字符串 `"unknown"` —— **不要**拒绝、不要抛错、不要 warn log（避免主流程被 metric 拖累）。
- **调用点只增 emit，不改业务逻辑**：
  - `src/retrieval/orchestrator.ts`：resolve 入口 `recordRetrievalCall(request.surface, request.intent)`；返回前若 `response.bundle.sections.some(s => s.records.length > 0)` 为 true 且 `response.bundle.bundle_digest !== "error"` 则 `recordRetrievalNonempty(request.surface, request.intent)`。**契约见 `src/core/contracts/bundle.ts:18-27`**。用 `some()`（短路），不要 `flatMap().length`。
  - `src/usage/usage-ack-handler.ts`：`putResult.status === "inserted"` 分支 `recordUsageAck(ack.surface, ack.sufficiency, ack.host_tier)`；loop guard `overrideSucceeded === true` 分支 `recordLoopOverride(ack.surface)`。注意 surface 在 ack handler 里取自 `previousCheckpoint.surface`（如 checkpoint 缺失则整个 emit 跳过，不 emit `unknown` 以防污染采样）。
  - `src/retrieval/circuit-breaker.ts`：每次 transitionTo emit `setCircuitState(surface, state)`；closed → open 时遍历返回的 reasons 数组，每个 reason emit `recordCircuitTrip(surface, reason)`。
- **依赖注入**：registry 实例由 `src/api/server.ts` 或 services 初始化处创建，注入给需要 emit 的 handler / orchestrator / breaker。**不要**用全局 mutable 单例；保持和现有 MetricsCollector 同款生命周期。

## P8-034.2 — 核心 5 指标 families

```
vega_retrieval_calls_total               counter  labels=[surface,intent]
vega_retrieval_nonempty_total            counter  labels=[surface,intent]
vega_usage_ack_total                     counter  labels=[surface,sufficiency,host_tier]
vega_usage_followup_loop_override_total  counter  labels=[surface]
vega_circuit_breaker_state               gauge    labels=[surface]          value ∈ {0:closed, 1:open, 2:cooldown}
vega_circuit_breaker_trips_total         counter  labels=[surface,reason]   reason ∈ {low_ack_rate, high_followup_rate}
vega_raw_inbox_rows                      gauge    labels=[event_type]       scrape-time COUNT(*)
vega_raw_inbox_oldest_age_seconds        gauge    labels=[event_type]       scrape-time now - MIN(received_at)
```

每个 metric 的 HELP 文本必须包含：
- 触发点（哪个 handler / transition / 查询语句）
- 是否 per-process / scrape-time
- 是否 proxy（`vega_usage_followup_loop_override_total` HELP 明写 "proxy signal for sufficiency false-positive, derived from loop guard override"）
- circuit_state gauge HELP 明写 "per-process, resets on restart"

### Cardinality budget（总 series）
`28 + 28 + 63 + 7 + 7 + 14 + ~5 + ~5 = 157` series（raw_inbox event_type 取决于线上实际，上限 ~10），远低于 2000 预算。

## P8-034.3 — `/metrics` 端点扩展

`src/api/server.ts:315` 已有 `/metrics` endpoint + auth gate + `metricsEnabled` 配置。本批次：
- 在 services 初始化处实例化 `createVegaMetrics(collector, db)`，把 registry 注入到 retrieval orchestrator / usage-ack handler / circuit breaker 构造参数
- **不修改** `/metrics` endpoint 本身的 auth / config / 响应头逻辑
- **不新增** env 变量（复用 `VEGA_METRICS_ENABLED` / `VEGA_METRICS_REQUIRE_AUTH`）
- 保留现有 `http_requests_total` / `http_request_duration_seconds` 正常渲染

## Acceptance criteria

1. `GET /metrics` 返回 **所有 8 个 vega_* metric families**，每个带合法 HELP + TYPE 行（counter 初始可 0 series，但 HELP/TYPE 必须先注册）
2. `npm run build` & `npm test` 全绿
3. 现有测试**一字未改**（`git diff src/tests/` 对已有 `.test.ts` 零行变更）
4. HTTP endpoints `/api/*` 响应 byte-identical（手工或 curl 抽查若干端点不崩；snapshot 对比归 Batch 10b）
5. Circuit breaker 既有 Wave 4 测试全绿（P8-024 / P8-025 不得回归）
6. Loop guard 路径（P8-022 既有测试）不得回归
7. `metricsEnabled=false` 时 `/metrics` 仍 404；`metricsRequireAuth=true` 时未鉴权仍 401
8. Raw inbox 两个 gauge 在空表时：返回**空 series set**（不要 emit `event_type=""` 的 zero 行，也不要抛错）
9. 未知 surface / intent / sufficiency / host_tier / reason 值不导致 panic，label 值被替换为 `"unknown"`
10. `vega_retrieval_nonempty_total` 的 nonempty 判定基准严格使用 bundle contract sections[].records[]；error bundle（bundle_digest === "error"）永远不算 nonempty；如 sections=[] 或所有 sections 的 records 均为空，亦不算 nonempty

## Review checklist（open-ended, self-driven）
- 所有 label 值是否都走 canonical enum / 本文件声明的常量？有无硬编码字符串？
- 未知标签值是否被安全映射为 `"unknown"` 而非抛错 / warn log？
- circuit state gauge 的 0/1/2 编码是否在 HELP 里写清？
- raw_inbox gauge 的 scrape 时间查询是否用 `prepare` 缓存？
- emit 调用点是否真的"只加一行" —— 有没有顺手改业务逻辑 / 改错误处理 / 改返回值？
- Known limitations 七条是否原样落到代码注释 + commit body？
- 依赖注入 vs 全局单例：有没有引入新的 module-level mutable 单例？
- `src/core/contracts/**` 有无改动？应为零。
- 有没有误把 `raw_inbox_backlog_total` / `raw_inbox_oldest_age_max` 注册成 metric family？应为零。

## Commit discipline
- Commit message body 必须包含：`Closes P8-034.0, P8-034.1, P8-034.2, P8-034.3`
- 单个 atomic commit，不 split
- Commit title 前缀 `feat(monitoring):`
- 不要在本 batch 创建 markdown 文档文件；label 字典写在 `vega-metrics.ts` 顶部注释
- 不要修改 `README.md` / `CLAUDE.md` / 任何根目录非代码文件
- **commit body 必须复述 Known limitations 七条（原样或语义等价）**，便于未来 grep 审计
