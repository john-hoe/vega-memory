# VM2-009：taxonomy 版本化与人工覆写 / 回退机制

## 背景
VM2-008 引入了 topic/room taxonomy 和 topic-first recall。现在需要防止 topic 漂移伤 recall，支持版本化、覆写与回退。

## 重要约束
- topics 表已有 version 和 state 字段
- 覆写时旧版本 state=superseded，新版本 version+1
- 不能静默重写历史分类

## 必须先读的代码
- src/db/schema.ts — topics 表（topic_key, version, state, supersedes_topic_id）
- src/core/types.ts — Topic, MemoryTopic
- src/core/topic-service.ts — 现有骨架
- src/core/recall.ts — topic recall 实现
- src/db/repository.ts — topic 相关查询

## 实现要求

### TopicService 完善
路径：扩展 src/core/topic-service.ts
- overrideTopic(project, topicKey, newLabel, newDescription?): 覆写 topic
  - 旧版本 state=superseded
  - 新版本 version+1, source=explicit
  - memory_topics 指向新 topic_id
- revertTopic(project, topicKey, targetVersion): 回退到指定版本
- listTopicVersions(project, topicKey): 查看版本历史
- reassignMemoryTopic(memoryId, fromTopicKey, toTopicKey): 重新分类

### 版本化规则
- 每次覆写创建新版本，不修改旧版本记录
- 旧版本保留完整数据（可审计）
- memory_topics.status 同步更新（旧关联 superseded，新关联 active）

### 审计日志
- topic 覆写/回退操作记录到 audit_log
- 包含 actor, action, detail

### MCP/CLI 工具
- topic_override: 覆写 topic
- topic_revert: 回退到指定版本
- topic_history: 查看版本历史
- topic_reassign: 重新分类记忆

## 交付物
1. topic-service.ts 完善
2. repository.ts 扩展
3. MCP 工具
4. 审计日志集成
5. 测试

## 质量要求
- npm run build 通过
- npm test 通过
- 版本化操作可审计、可回退
