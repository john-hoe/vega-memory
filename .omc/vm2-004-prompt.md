# VM2-004：建立 token / latency / recall regression 护栏与仪表

## 背景
Vega Memory 二期第四个任务。VM2-001（统一 recall 协议）已完成。现在需要建立 regression 护栏，防止后续功能升级导致 token 成本上升、延迟增加或召回质量下降。

## 重要约束
- 这是【实现】任务，需要写代码
- 在现有 performance_log 基础上扩展，不另起炉灶
- 护栏是可配置的阈值，超出时发出警告但不阻断
- 仪表是可查询的指标，支持 CLI 和 API 输出

## 必须先读的代码
- src/db/schema.ts — performance_log 表结构
- src/db/repository.ts — logPerformance 方法
- src/core/session.ts — token_estimate 计算逻辑、SESSION_BUDGET_RATIOS
- src/core/recall.ts — recall 延迟、性能日志
- src/core/health.ts — 现有健康检查
- src/core/analytics.ts — 现有分析指标
- src/search/engine.ts — 慢查询追踪（slowQueryTracker）
- src/config.ts — 配置加载
- docs/specs/vm2-001-recall-protocol.md — 协议定义的 budget 策略

## 需要实现的指标

### Token 指标
- session_start_token_estimate: 每次 session_start 的 token 估算
- session_start_token_by_mode: light vs standard 的 token 分布
- recall_result_token_estimate: 每次 recall 返回的 token 估算
- token_budget_utilization: 实际使用 / 预算上限的比率

### Latency 指标
- session_start_latency_ms: session_start 端到端延迟
- recall_latency_ms: recall 端到端延迟（已有部分）
- embedding_latency_ms: Ollama embedding 延迟
- p50/p95/p99 延迟百分位

### Recall 质量指标
- recall_result_count: 每次 recall 返回的结果数
- recall_avg_similarity: 平均相似度分数
- recall_top_k_inflation: top-k 结果中低分结果的占比
- evidence_pull_rate: deep_recall 调用频率（预留，VM2-006 后生效）

### 护栏阈值（可配置）
- max_session_start_token: 默认 2500（超出警告）
- max_recall_latency_ms: 默认 500ms（超出警告）
- min_recall_avg_similarity: 默认 0.4（低于警告）
- max_top_k_inflation_ratio: 默认 0.3（超出警告）

## 交付物

### 1. 护栏配置
路径：扩展 src/config.ts
内容：新增 regression guard 配置项，支持环境变量覆盖

### 2. 指标收集服务
路径：新增 src/core/regression-guard.ts
内容：
- RegressionGuard 类
- recordSessionStart(mode, tokenEstimate, latencyMs) 方法
- recordRecall(resultCount, avgSimilarity, latencyMs) 方法
- checkThresholds() 方法 — 返回违规列表
- getReport() 方法 — 返回指标摘要

### 3. 集成到现有服务
- session.ts: sessionStart 完成后调用 recordSessionStart
- recall.ts: recall 完成后调用 recordRecall
- health.ts: getHealthReport 中包含 regression guard 状态

### 4. CLI 命令
路径：新增 src/cli/commands/regression.ts 或扩展 health 命令
内容：vega health --regression 输出护栏状态和指标摘要

### 5. MCP 工具扩展
路径：扩展 src/mcp/server.ts
内容：memory_health 返回中包含 regression guard 数据

### 6. 测试
路径：新增 src/tests/regression-guard.test.ts
内容：
- 阈值检测测试
- 指标记录测试
- 报告生成测试

## 质量要求
- 先读完所有相关源码再动手
- 不破坏现有功能和测试
- npm run build 通过
- npm test 通过（现有 475 + 新增测试全绿）
- 如果遇到架构决策问题，用 ask-claude 反问确认
