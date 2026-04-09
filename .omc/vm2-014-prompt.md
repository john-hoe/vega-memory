# VM2-014：分阶段发布与 feature flag 回滚策略

## 背景
VM2 二期已完成多个新功能（时序事实、冷存档、topic taxonomy、regression 护栏）。需要设计 feature flag 机制确保新功能可以安全关闭/回滚，旧主链能独立运行。

## 重要约束
- 采用 sidecar + feature flag + phased rollout
- 旧 hot memory 主链必须可独立运行
- 在 recall/token 回归时能快速回滚

## 必须先读的代码
- src/config.ts — 配置加载，看已有的配置模式
- src/core/session.ts — sessionStart，看 mode 参数如何路由
- src/core/recall.ts — topic recall 实现
- src/core/archive-service.ts — deep_recall 实现
- src/core/regression-guard.ts — regression 护栏
- src/db/schema.ts — fact_claims, raw_archives, topics, memory_topics 新表

## 设计要求

### Feature Flags
在 config.ts 中新增以下开关（环境变量覆盖）：
- VEGA_FEATURE_FACT_CLAIMS: 启用时序事实层（默认 false）
- VEGA_FEATURE_RAW_ARCHIVE: 启用冷存档层（默认 true，因为 VM2-006 已实现）
- VEGA_FEATURE_TOPIC_RECALL: 启用 topic recall（默认 false）
- VEGA_FEATURE_DEEP_RECALL: 启用 deep_recall 端点（默认 true）
- 每个 flag 用 parseBoolean，默认值按当前代码稳定度设置

### Phased Rollout 策略
在规格文档中定义：
- Phase A: raw_archive + deep_recall（已实现，默认开启）
- Phase B: topic_recall（代码已实现但需更多测试）
- Phase C: fact_claims（schema 和类型已定义，运行时逻辑待实现）
- 每个 phase 的进入/退出条件（regression guard 指标达标）

### 回滚机制
- flag 关闭时，相关代码路径被跳过，不报错
- session_start 在 flag 关闭时不查询 sidecar 表
- recall 在 topic flag 关闭时回退到现有行为
- deep_recall 在 flag 关闭时返回 501

### 集成点
- session.ts: 检查 flag 再决定是否查询 sidecar
- recall.ts: 检查 topic flag
- routes.ts: 检查 deep_recall flag
- mcp/server.ts: 同步检查

## 交付物
1. 规格文档：docs/specs/vm2-014-feature-flags.md
2. config.ts 扩展：feature flag 配置
3. 代码集成：在关键路径加 flag 检查
4. 测试：flag 开/关两种场景的回归测试

## 质量要求
- npm run build 通过
- npm test 通过
- flag 全关时行为与 VM2 之前完全一致
