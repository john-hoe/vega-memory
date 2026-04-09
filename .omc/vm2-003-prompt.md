# VM2-003：设计时序事实验证机制（confidence / source / status）

## 背景
VM2-001（统一 recall 协议）和 VM2-002（数据模型边界）已完成。VM2-002 已在 schema.ts 中新增了 fact_claims 表，包含 valid_from/valid_to/confidence/source/status 字段。现在需要设计验证机制，防止 valid_from/valid_to 假精确。

## 重要约束
- 这是【设计 + 规格】任务，可以写类型定义，但不实现运行时逻辑
- 不改现有 hot memory 主链行为
- fact_claims 表已存在于 schema.ts，不需要重新建表

## 必须先读的代码
- src/db/schema.ts — fact_claims 表定义（已有 valid_from, valid_to, confidence, status, source 字段）
- src/core/types.ts — FactClaim, FactClaimStatus 等已有类型
- docs/specs/vm2-002-data-model-boundary.md — 四层模型规格
- docs/specs/vm2-001-recall-protocol.md — recall 协议
- src/core/knowledge-graph.ts — 现有 KG 实体/关系提取逻辑

## 设计要求

### 验证等级
定义 confidence 的含义和分级策略：
- 1.0: user verified（用户确认）
- 0.7-0.9: explicit store（用户主动存储的内容推导）
- 0.4-0.6: auto extracted（LLM 从 session summary 提取）
- 0.1-0.3: inferred（从关联记忆推断）
- 规则：confidence 只能被用户操作提升，不能被系统自动提升

### Source 追溯
- hot_memory: 从 hot memory 提取的事实
- raw_archive: 从原文存档提取的事实
- manual: 用户直接创建的事实
- mixed: 多来源交叉验证
- 必须保留 source_memory_id 和 evidence_archive_id 追溯链

### Status 状态机
定义合法的状态转换：
- active -> expired: 时间过期或被新事实替代
- active -> suspected_expired: 系统推测过期（等用户确认）
- active -> conflict: 发现矛盾事实
- suspected_expired -> active: 用户确认仍有效
- suspected_expired -> expired: 用户确认已过期
- conflict -> active: 用户解决冲突
- conflict -> expired: 用户选择废弃

### 防止假精确
- valid_from 不应精确到秒，除非有明确时间戳证据
- 如果只知道"大概是 4 月"，valid_from 应设为月初
- 如果不确定结束时间，valid_to 应为 null（不设假截止）
- 定义 temporal_precision 字段或枚举：exact, day, week, month, quarter, unknown

### as_of 查询语义
- 定义 as_of(timestamp) 查询的语义：返回在该时间点 status=active 且 valid_from <= timestamp < valid_to 的事实
- valid_to = null 表示"目前仍有效"
- 定义如何处理 suspected_expired 的事实在 as_of 查询中的行为

## 交付物

### 1. 验证机制规格文档
路径：docs/specs/vm2-003-fact-verification.md
内容：
- confidence 分级定义和提升规则
- source 追溯规则
- status 状态机（含状态转换图）
- 防假精确策略
- as_of 查询语义
- 与 session_start 的集成策略（expired/suspected_expired 不进入 session context）

### 2. TypeScript 类型扩展
路径：扩展 src/core/types.ts
内容：
- TemporalPrecision 类型
- FactClaimTransition 类型（合法状态转换）
- AsOfQueryOptions 接口
- 扩展现有 FactClaim 接口（如需要增加 temporal_precision 字段）

### 3. Schema 扩展（如需要）
路径：src/db/schema.ts
内容：如果需要给 fact_claims 增加 temporal_precision 字段

## 质量要求
- 先读完所有相关源码和已有规格文档再设计
- 类型定义必须与现有代码兼容
- npm run build 通过
- npm test 通过（不破坏现有 481 测试）
