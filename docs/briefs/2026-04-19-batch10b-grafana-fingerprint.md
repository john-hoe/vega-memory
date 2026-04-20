# Batch 10b — P8-034.4 Grafana dashboard + P8-034.5 metrics fingerprint & snapshot tests

## Context
10a stack（commits `7692b92..03bbe6e`）已在 Round-3 PASS sealed，8 个 `vega_*` metric families 在 `/metrics` 稳定渲染。本批次收尾 P8-034 parent 的剩余 2 个 sub-task：
- **P8-034.4**：Grafana dashboard JSON（6 面板）
- **P8-034.5**：metrics fingerprint（机器可读的 metric 契约 + 结构化 snapshot 测试防漂移）

## Scope

### 1. Grafana dashboard (P8-034.4)
- 新文件 `dashboards/vega-runtime-core.json`：Grafana dashboard JSON（schema version 38+，Grafana 10+ 兼容）
- 必须包含以下 **6 个 panel**，PromQL 与 10a brief 中 Dashboard 映射表里的 default view / drill-down 行严格一致：

| Panel title | Panel type (建议) | PromQL |
|---|---|---|
| Coverage (hit rate) | stat or timeseries | `sum(rate(vega_retrieval_nonempty_total[5m])) / sum(rate(vega_retrieval_calls_total[5m]))` |
| Sufficiency FP rate (proxy) | stat or timeseries | `sum(rate(vega_usage_followup_loop_override_total[1h])) / sum(rate(vega_usage_ack_total{sufficiency="needs_followup"}[1h]))` |
| Host tier distribution | piechart or bargauge | `sum by (host_tier) (rate(vega_usage_ack_total[5m]))` |
| Circuit breaker state | state-timeline or stat | `vega_circuit_breaker_state` |
| Raw inbox backlog (total) | stat | `sum(vega_raw_inbox_rows)` |
| Raw inbox oldest age (max) | stat | `max(vega_raw_inbox_oldest_age_seconds)` |

- Panel "Sufficiency FP rate (proxy)" 标题必须带 "(proxy)" 后缀 —— 10a Known limitation #6 防止口径误解
- Panel "Circuit breaker state" 的 value mappings 必须含 `0 → closed`、`1 → open`、`2 → cooldown`（对应 10a vega-metrics.ts 编码）
- 顶部 `title` 字段建议 `"Vega Runtime Core"`；`uid` 建议固定 `"vega-runtime-core"`（stable ID 便于未来 provisioning）
- datasource 引用用 `${datasource}` 模板变量，不写死 UID
- 可选：`dashboards/README.md` 一行说明（"Grafana dashboards for Vega; import via Grafana UI or provisioning"）

### 2. Metrics fingerprint (P8-034.5 — single source of truth)
- 新文件 `src/monitoring/metrics-fingerprint.ts`：导出典型 TS 类型 + 只读 const 数组
  ```ts
  export type MetricType = "counter" | "gauge" | "histogram";
  export interface MetricFingerprint {
    readonly name: string;
    readonly type: MetricType;
    readonly labelKeys: readonly string[];
    readonly helpFragment: string; // 一段应出现在 HELP 行里的关键子串
  }
  export const METRICS_FINGERPRINT: readonly MetricFingerprint[] = [
    // 8 entries, 一行对应 10a vega-metrics.ts 中注册的每个 family
  ] as const;
  ```
- 8 个 entry 的字段必须与**仓库当前** `src/monitoring/vega-metrics.ts` 注册状态**一致**（实际抓 HELP/TYPE 对齐）：
  1. `vega_retrieval_calls_total` / counter / `["surface","intent"]`
  2. `vega_retrieval_nonempty_total` / counter / `["surface","intent"]`
  3. `vega_usage_ack_total` / counter / `["surface","sufficiency","host_tier"]`
  4. `vega_usage_followup_loop_override_total` / counter / `["surface"]`
  5. `vega_circuit_breaker_state` / gauge / `["surface"]`
  6. `vega_circuit_breaker_trips_total` / counter / `["surface","reason"]`
  7. `vega_raw_inbox_rows` / gauge / `["event_type"]`
  8. `vega_raw_inbox_oldest_age_seconds` / gauge / `["event_type"]`
- `helpFragment` 每条选 HELP 文本里稳定且有辨识度的一段子串（不要选"proxy"、"per-process"等可能改措辞的元信息；选 metric 实际语义的短语）
- **fingerprint 是 parallel spec，不重构 vega-metrics.ts** —— 保持 10a 代码字节不变

### 3. Snapshot / drift test (P8-034.5 — oracle 检查)
- 新文件 `src/tests/metrics-fingerprint.test.ts`：用 `METRICS_FINGERPRINT` 作 oracle 对 `collector.getMetrics()` 做结构化校验
- 至少 3 个 test case：
  1. **Catalog test**：fingerprint 每条都在 rendered 里有对应 `# HELP <name>` + `# TYPE <name> <type>`；HELP 行包含 `helpFragment`
  2. **Label contract test**：对每个 fingerprint 条目，通过对应 emit 方法 fire 一个 sample label set（用 canonical 值），然后解析 rendered，确认该 metric 的 series line 精确包含 `labelKeys` 列表（不多不少，顺序不限）
  3. **Catalog completeness test**：rendered 里所有 `# TYPE vega_` 开头的行，其 metric name 都**必须**在 fingerprint 里出现 —— 防止新增 metric 漏登记到 fingerprint
- 测试必须跨平台 hermetic（用 `:memory:` + 不碰 HOME / keychain / 真实 user config —— 继续 10a.3/10a.4 的 DI 原则）
- **不使用** 任何 byte-exact fixture 文件（避免脆性）；所有断言都是结构化 regex / JSON 解析 / Set 对比

## Out of scope — do NOT touch
- `src/monitoring/vega-metrics.ts` / `src/monitoring/metrics.ts`（10a 已 sealed，字节不变）
- `src/api/server.ts` / `src/retrieval/**` / `src/usage/**` / `src/scheduler/**`（emit wiring & DI 不改）
- 10a.1 revert-locked 4 文件（`src/config.ts` / `src/security/keychain.ts` / `src/core/integration-surface-status.ts` / `src/cli/commands/doctor.ts`）
- 其他已存在测试文件一律不改
- P8-035 alert 规则（独立 parent）
- P8-032 reconciliation（独立 parent）
- Grafana datasource provisioning / ops 部署脚本（超出 dashboard JSON 范围）
- 任何 DB schema / migration / contract 改动
- 从 fingerprint.ts 自动生成 markdown 文档（Wave 6 清理）

## Forbidden files
- 所有 10a Out of scope 段列出的文件（继承）
- `src/monitoring/vega-metrics.ts` / `src/monitoring/metrics.ts`（10a 字节不变）
- 除 `src/tests/metrics-fingerprint.test.ts` 外所有 `src/tests/**`
- `docs/**` 下 briefs 之外的任何文件不改动；**可以**新建 `dashboards/README.md` 但不是必须
- `current-status.md` / `next-step.md` / `ROADMAP.md` / `EXECUTION_PLAN.md` / `PHASE4_VISION.md` 一律不新增或修改
- 本 brief 本身

## Forbidden patterns（Wave 5 全程继续）
- Production 代码不得嗅探测试环境
- Production 代码不得分支走"只在测试生效"
- 测试严禁触碰 macOS 真实钥匙串、真实用户 HOME、真实用户 config 文件；隔离只能靠 DI / 参数注入 / mock
- fingerprint.ts **不得** import 或被 import 自 `vega-metrics.ts`（保持 parallel spec，防止循环依赖 / 隐式耦合）

## Acceptance criteria
1. `dashboards/vega-runtime-core.json` 存在；`node -e 'JSON.parse(require("fs").readFileSync("dashboards/vega-runtime-core.json","utf8"))'` 成功（合法 JSON）
2. JSON 根对象含 `schemaVersion >= 38`、`uid === "vega-runtime-core"`、`title === "Vega Runtime Core"`
3. `panels` 数组长度 **≥ 6**；每个 panel 的 `targets[].expr` 至少命中上面表格中一条 PromQL（精确字符串匹配，允许空白归一化）
4. "Sufficiency FP rate" 面板 title 含子串 `"(proxy)"`
5. "Circuit breaker state" 面板含 3 个 value mappings：`0→closed`、`1→open`、`2→cooldown`
6. `src/monitoring/metrics-fingerprint.ts` 导出 `METRICS_FINGERPRINT`，长度 === 8，每条 name 必须 === 上面"8 个 entry"子列表里的对应 name（顺序不限，用 Set 比）
7. `grep -nE 'import.*vega-metrics|from.*vega-metrics' src/monitoring/metrics-fingerprint.ts` 返回空（parallel spec，不 import）
8. `grep -nE 'import.*metrics-fingerprint|from.*metrics-fingerprint' src/monitoring/vega-metrics.ts` 返回空（反向亦然）
9. `src/tests/metrics-fingerprint.test.ts` 新文件，3 个 test case 按 Scope #3 的描述落实
10. `git diff HEAD -- src/monitoring/vega-metrics.ts src/monitoring/metrics.ts` 输出为空
11. `npm run build` 成功退出；`npm test` 全绿（具体测试数不做死约束，以 pass/fail 计数为准）
12. 严格**不 amend** commit `03bbe6e`，新起 commit 在其上
13. Commit title 前缀 `feat(monitoring):` 或 `feat(dashboards):`
14. Commit body 必须包含 `Closes P8-034.4, P8-034.5` 和：
    ```
    Adds Grafana dashboard (6 panels matching the 10a Dashboard mapping)
    and a parallel metrics fingerprint (src/monitoring/metrics-fingerprint.ts)
    used as oracle by a structural drift test. Fingerprint intentionally
    does NOT import or export to vega-metrics.ts — any drift between the
    two is surfaced by the test rather than compiled away.

    Scope-risk: low
    Reversibility: clean
    ```

## Review checklist
- Dashboard JSON 的 6 panel PromQL 是否精确匹配 10a 映射表？有没有混进私货 panel（例如 alerts / annotations）？
- "(proxy)" 后缀 + value mappings 是否落位？
- fingerprint.ts 的 8 条 name 是否和仓库当前 vega-metrics.ts 注册状态一致（可跑一次 `/metrics` 渲染对照）？
- fingerprint.ts 有没有悄悄 import 了 vega-metrics.ts 的类型或常量（禁止，parallel spec 原则）？
- 测试的 3 个 case 是否真覆盖：catalog / label contract / completeness？completeness 那条能否检出"新加了 metric 忘了登 fingerprint"？
- 测试是否触碰了真实 HOME / keychain / config？应该全部 `:memory:` + DI？
- 10a 文件（vega-metrics.ts / metrics.ts）diff 是不是真的零？
- 新 commit 是不是在 `03bbe6e` 下方（`git log --oneline -2`）？

## Commit discipline
- 单 atomic commit，新起，不 amend
- 前缀 `feat(monitoring):` 或 `feat(dashboards):`
- body 按 Acceptance #14 模板
- 不创建 markdown / root-level 文档
- `dashboards/README.md` 可选新建（1-2 行说明即可）；不强制
