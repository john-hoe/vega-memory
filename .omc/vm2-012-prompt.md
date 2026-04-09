# VM2-012：建立 Vega Memory 二期 benchmark 套件（token / recall / latency）

## 背景
对齐标准记忆 benchmark 与真实工作流指标，验证二期改动是否真的省 token、提升召回并保持延迟可控。

## 必须先读的代码
- src/core/regression-guard.ts — 已有的 regression 指标
- src/tests/ — 现有测试结构
- src/cli/commands/benchmark.ts — 如果存在的话
- src/db/repository.ts — performance_log 查询

## 实现要求

### Benchmark 套件
路径：新增 src/tests/benchmark/ 目录

#### Token Benchmark
- 测量 session_start(L0/L1/L2) 的 token_estimate
- 测量 recall 返回结果的 token 估算
- 对比不同 mode 的 token 差异

#### Recall Quality Benchmark
- 准备测试数据集（预设 memories + 已知正确答案）
- 测量 recall@5, recall@10 的命中率
- 测量 topic-filtered vs unfiltered recall 精准度差异
- 测量 fact_claims as_of 查询的正确性

#### Latency Benchmark
- 测量 session_start 各 mode 延迟
- 测量 recall 延迟（不同数据规模：100/500/1000 memories）
- 测量 deep_recall 延迟
- 输出 p50/p95/p99

### CLI 命令
- vega benchmark run：运行完整 benchmark 套件
- vega benchmark report：输出最近一次结果
- 结果存储到 data/benchmarks/ 目录

### 报告格式
- JSON + markdown 双格式输出
- 包含：测试时间、数据规模、各指标值、是否通过阈值
- 可与之前的结果对比（趋势追踪）

## 交付物
1. src/tests/benchmark/ 测试套件
2. CLI benchmark 命令
3. 报告生成逻辑
4. 测试

## 质量要求
- npm run build 通过
- npm test 通过
- benchmark 本身可在 CI 中运行
