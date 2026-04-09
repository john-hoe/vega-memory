# VM2-005：实现时序事实层 valid_from / valid_to / as_of recall

## 背景
VM2-002 建了 fact_claims 表，VM2-003 设计了验证机制（confidence/source/status/temporal_precision），VM2-014 加了 feature flag。现在实现运行时逻辑。

## 重要约束
- 受 VEGA_FEATURE_FACT_CLAIMS flag 控制（flag 关闭时跳过）
- 不改 hot memory 主链行为
- fact_claims 是 sidecar，session_start 排除已过期事实

## 必须先读的代码
- src/db/schema.ts — fact_claims 表（含 temporal_precision）
- src/core/types.ts — FactClaim, FactClaimStatus, TemporalPrecision, AsOfQueryOptions, FactClaimTransition
- src/config.ts — feature flags（VEGA_FEATURE_FACT_CLAIMS）
- src/db/repository.ts — 现有 CRUD 方法
- src/core/memory.ts — MemoryService store 流程
- docs/specs/vm2-003-fact-verification.md — 验证机制规格

## 实现要求

### Repository 扩展
- createFactClaim(claim): 创建事实
- getFactClaim(id): 获取事实
- listFactClaims(project, status, asOf?): 列表查询，支持 as_of 过滤
- updateFactClaimStatus(id, status, reason?): 状态转换
- findConflictingClaims(project, subject, predicate): 查找冲突事实

### FactClaimService
路径：新增 src/core/fact-claim-service.ts
- extractClaims(memoryId): 从 hot memory 提取事实（用 Ollama）
- expireClaim(id, reason): 标记过期
- markSuspectedExpired(id): 标记疑似过期
- resolveClaim(id, newStatus): 用户解决冲突
- asOfQuery(project, timestamp, subject?, predicate?): as_of 查询

### Session 集成
- session_start 时如果 flag 开启，排除 expired/suspected_expired 事实相关的 hot memory
- 在 proactive_warnings 中加入 conflict 状态的事实提醒

### MCP 工具
- fact_claim_list: 列表查询
- fact_claim_update: 状态更新（用户操作）
- fact_claim_query: as_of 查询

### 状态转换验证
- 实现 VM2-003 定义的合法状态转换
- 非法转换抛错

## 交付物
1. src/core/fact-claim-service.ts
2. repository.ts 扩展
3. MCP 工具
4. session.ts 集成
5. 测试

## 质量要求
- npm run build 通过
- npm test 通过
- flag 关闭时行为与之前完全一致
