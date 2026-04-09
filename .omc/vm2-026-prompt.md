# VM2-026：compact 等路径补 sidecar reconciler（claims/topics 重建）

## 背景
VM2-002 发现：compact 和 Repository.updateMemory() 直接操作 hot memory，不会同步更新 fact_claims/topics sidecar。VM2-005 实现了 fact claims，VM2-008/009 实现了 topics。现在需要异步 reconciler 保持 sidecar 一致性。

## 必须先读的代码
- src/core/compact.ts — CompactService（merge/archive 逻辑）
- src/core/memory.ts — MemoryService update/delete
- src/core/fact-claim-service.ts — FactClaimService
- src/core/topic-service.ts — TopicService
- src/db/repository.ts — updateMemory, deleteMemory

## 实现要求

### Reconciler Service
路径：新增 src/core/sidecar-reconciler.ts
- SidecarReconciler 类
- onMemoryMerged(keptId, mergedIds): compact 合并后，把 merged 记忆的 claims/topics 迁移到 kept
- onMemoryArchived(memoryId): 归档后，把关联的 claims 标记 suspected_expired
- onMemoryDeleted(memoryId): 删除后，清理孤立的 claims/topics 关联
- reconcileAll(project?): 全量扫描修复不一致

### 集成到 CompactService
- compact 完成 merge 后调用 onMemoryMerged
- compact 完成 archive 后调用 onMemoryArchived

### 集成到 MemoryService
- delete 后调用 onMemoryDeleted

### 安全性
- reconciler 操作记录 audit_log
- 不自动删除 fact_claims，只标记状态变更
- topics 关联更新但不删除 topic 定义本身

## 交付物
1. src/core/sidecar-reconciler.ts
2. compact.ts 集成
3. memory.ts 集成
4. 测试

## 质量要求
- npm run build 通过
- npm test 通过
