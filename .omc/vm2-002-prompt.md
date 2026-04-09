# VM2-002：拆分 hot memory / fact claims / raw archive / topics 数据模型边界

## 背景
Vega Memory 二期第二个任务。VM2-001（统一 recall 协议）已完成，定义了 session_start(light/standard)、recall、deep_recall、session_end 的协议。现在需要设计数据模型边界，为后续时序事实、冷存档、topic taxonomy 打基础。

## 重要约束
- 这是【设计 + 规格 + schema 定义】任务
- 采用 sidecar 分层，不重写现有 hot memory 主链
- 现有 memories 表保持不变，新增 sidecar 表
- memory 表不承担多角色，每层有明确的 source of truth

## 必须先读的代码
- src/db/schema.ts — 现有 schema（memories, memory_versions, sessions, entities, relations, wiki_pages 等）
- src/core/types.ts — 现有类型定义，包括 VM2-001 新增的 SessionStartMode、DeepRecallRequest 等
- src/core/session.ts — sessionStart 实现
- src/core/memory.ts — MemoryService store/update/delete
- src/core/compact.ts — CompactService 合并/归档逻辑
- src/core/knowledge-graph.ts — 知识图谱实体/关系
- docs/specs/vm2-001-recall-protocol.md — VM2-001 协议规格

## 设计要求

### 四层数据模型

#### Layer 1: Hot Memory（现有 memories 表，不改）
- 当前 6 种类型：task_state, preference, project_context, decision, pitfall, insight
- 有 summary 压缩、budget 裁剪、importance 排序
- session_start 注入的主数据源
- Source of truth: 结构化的、经过压缩的工作记忆

#### Layer 2: Fact Claims（新增 sidecar 表）
- 时序事实：valid_from, valid_to, confidence, source, status
- 从 hot memory 或 cold archive 提取的事实断言
- 支持 as_of 查询、失效操作
- Source of truth: 有时间边界的事实声明
- Status: active, expired, suspected_expired, conflict

#### Layer 3: Raw Archive（新增 sidecar 表）
- 原文冷存档：transcript, 长讨论, 设计辩论, 导出的 chat/log
- 默认不注入 session context
- 只在 deep_recall 时按需拉取
- Source of truth: 未经处理的原始文本
- 需要 content hash 去重

#### Layer 4: Topics（新增 sidecar 表或扩展字段）
- 轻量 topic/room 分类
- 自动生成 + 人工覆写
- 版本化（防止 topic 漂移）
- Source of truth: 记忆的语义分类

### 表间关系
- hot memory -> fact claims: 一对多（一条记忆可提取多个事实）
- hot memory -> raw archive: 可选关联（hot memory 可指向原文来源）
- hot memory -> topics: 多对多（一条记忆可属于多个 topic）
- fact claims -> raw archive: 可选（事实可引用原文作为证据）

## 交付物

### 1. 数据模型规格文档
路径：docs/specs/vm2-002-data-model-boundary.md
内容：
- 四层模型定义和 source of truth
- 每张表的字段设计（详细到类型和约束）
- 表间关系和引用规则
- 迁移策略（如何从现有 schema 演进）
- 不变量约束（什么操作不允许跨层直接修改）

### 2. Schema DDL
路径：在规格文档中包含完整的 CREATE TABLE 语句
内容：
- fact_claims 表
- raw_archives 表
- memory_topics 表（关联表）
- topics 表
- 必要的索引

### 3. TypeScript 类型定义
路径：扩展 src/core/types.ts
内容：
- FactClaim 接口
- RawArchive 接口
- Topic 接口
- MemoryTopic 关联接口
- FactClaimStatus 类型

### 4. 迁移脚本设计
路径：在规格文档中描述
内容：如何在 schema.ts 的 initializeDatabase 中增量添加新表（不破坏现有数据）

## 质量要求
- 先读完所有相关源码再设计
- 新类型必须与现有代码兼容
- schema 变更必须是增量的（ALTER TABLE ADD / CREATE TABLE IF NOT EXISTS）
- npm run build 通过
- npm test 通过（不破坏现有 475 测试）
- 如果遇到架构决策问题，用 ask-claude 反问确认
