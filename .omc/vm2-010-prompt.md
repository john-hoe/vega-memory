# VM2-010：构建跨项目 topic graph / tunnel 视图

## 背景
VM2-008 引入了 topic/room taxonomy，VM2-009 加了版本化和覆写。现在需要基于 topic/room 做跨项目 pitfall/decision/context 复用导航，增强经验迁移能力。

## 重要约束
- 基于已有 topics 和 memory_topics 表
- 不新建表，利用现有 knowledge-graph entities/relations 或 topics 跨项目查询
- tunnel = 同一 topic_key 在不同 project 中的实例关联

## 必须先读的代码
- src/db/schema.ts — topics, memory_topics 表
- src/core/topic-service.ts — TopicService 实现
- src/core/knowledge-graph.ts — KnowledgeGraphService
- src/db/repository.ts — topic 相关查询（listTopics, listMemoryIdsByTopic）
- src/core/types.ts — Topic, MemoryTopic, Entity, EntityRelation

## 实现要求

### 跨项目 Topic 查询
- listCrossProjectTopics(topicKey): 查找所有 project 中同一 topic_key 的实例
- getCrossProjectMemories(topicKey, type?): 获取跨项目中同一 topic 下的记忆（可按 type 过滤 pitfall/decision 等）

### Tunnel 视图
- getTunnelView(topicKey): 返回结构化视图
  - 哪些 project 有这个 topic
  - 每个 project 下有哪些记忆（按 type 分组）
  - 跨项目的共同 pitfall/decision 汇总

### MCP 工具
- topic_tunnel: 查看跨项目 tunnel 视图
- topic_cross_project: 跨项目 topic 记忆搜索

### CLI
- vega topic tunnel <topic_key>: 显示 tunnel 视图

## 交付物
1. TopicService 扩展（跨项目查询方法）
2. Repository 扩展
3. MCP 工具
4. CLI 命令
5. 测试

## 质量要求
- npm run build 通过
- npm test 通过
- 跨项目查询不影响现有单项目 recall 性能
