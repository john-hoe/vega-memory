# VM2-008：引入轻量 topic / room taxonomy 与回退策略

## 背景
VM2-002 已在 schema.ts 中新增了 topics 和 memory_topics 表。现在需要设计 topic/room 分类的生成策略、人工覆写机制、以及失败时回退到 tags/FTS 的策略。

## 重要约束
- 只加轻量 topic/room 字段与自动生成 + 人工覆写
- 不照搬 MemPalace 的完整 wing/hall/tunnel 架构
- 失败时必须能回退到现有 tags/FTS
- topics 表已存在于 schema.ts，不需要重新建表

## 必须先读的代码
- src/db/schema.ts — topics 表和 memory_topics 表（已有 topic_key, version, label, kind, source, state 字段）
- src/core/types.ts — Topic, MemoryTopic 已有类型
- src/core/memory.ts — MemoryService store 流程（看 tags 是怎么用的）
- src/core/recall.ts — RecallService 搜索流程（看如何加入 topic 过滤）
- src/search/engine.ts — SearchEngine hybrid search 实现
- docs/specs/vm2-002-data-model-boundary.md — topics 层定义

## 设计要求

### Topic 自动生成
- 新记忆存入时，用 Ollama 推断 topic（从 content + tags + project 推断）
- 如果 Ollama 不可用，回退到基于 tags 的规则匹配
- 生成的 topic 标记 source=auto, confidence 可选
- 同一个 topic_key 在同一个 project 下唯一（通过 version 管理变更）

### Topic 种类
- kind=topic: 粗粒度主题（如 database, auth, deployment）
- kind=room: 细粒度子分类（如 database/migration, database/indexing）
- room 隶属于 topic，通过 topic_key 前缀表达（如 database.migration）

### 人工覆写
- 用户可通过 CLI 或 MCP 工具手动设置/修改 topic
- 人工设置标记 source=explicit，优先级高于 auto
- 覆写时旧版本 state=superseded，新版本 version+1

### 回退策略
- 如果 topic 生成失败（Ollama 离线 + 规则匹配无结果），记忆仍正常存储，只是没有 topic 关联
- recall 时如果 topic 过滤无结果，自动回退到 tags + FTS 搜索
- 回退必须透明：返回结果中标记 fallback=true

### Recall 集成
- recall 新增可选 topic 参数
- 有 topic 时：先按 topic 缩小范围，再做 hybrid search
- 无 topic 时：保持现有行为不变

## 交付物

### 1. Topic Taxonomy 规格文档
路径：docs/specs/vm2-008-topic-taxonomy.md
内容：
- 自动生成策略
- kind 层级定义（topic vs room）
- 人工覆写和版本化规则
- 回退策略
- recall 集成方案

### 2. TypeScript 类型扩展
路径：扩展 src/core/types.ts
内容：
- TopicAssignmentRequest 接口
- TopicRecallOptions 接口（recall 的 topic 过滤参数）
- 扩展 SearchOptions 增加 topic 字段

### 3. Topic Service 骨架
路径：新增 src/core/topic-service.ts
内容：
- TopicService 类骨架（方法签名 + 注释，不实现逻辑）
- assignTopic(memoryId, topicKey, source)
- inferTopic(content, tags, project) -> topicKey
- listTopics(project)
- overrideTopic(memoryId, newTopicKey)

### 4. MCP/API 工具定义
路径：在规格文档中描述
内容：
- memory_store 扩展：可选 topic 参数
- memory_recall 扩展：可选 topic 过滤
- topic_list / topic_override 新工具定义

## 质量要求
- 先读完所有相关源码再设计
- 类型定义必须与现有代码兼容
- npm run build 通过
- npm test 通过（不破坏现有 481 测试）
