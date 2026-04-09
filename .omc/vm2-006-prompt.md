# VM2-006：实现 pull-only 原文冷存档层 raw archive / evidence tier

## 背景
VM2-001（recall 协议）、VM2-002（数据模型）、VM2-004（regression 护栏）已完成。VM2-002 已在 schema.ts 中新增了 raw_archives 表。VM2-001 定义了 deep_recall 端点（当前返回 501）。现在需要实现冷存档层的存取逻辑。

## 重要约束
- raw_archives 表已存在于 schema.ts，不需要重新建表
- deep_recall 的 501 占位已在 routes.ts 中，需要替换为真实实现
- 冷层内容默认不注入 session context
- 只在 deep_recall 时按需拉取
- 必须有 content_hash 去重

## 必须先读的代码
- src/db/schema.ts — raw_archives 表定义
- src/core/types.ts — RawArchive, DeepRecallRequest, DeepRecallResponse 类型
- src/api/routes.ts — POST /api/deep-recall 的 501 占位（需替换）
- src/mcp/server.ts — MCP 工具定义（需新增 deep_recall 工具）
- src/db/repository.ts — 数据访问层（需扩展）
- src/core/memory.ts — MemoryService store 流程
- src/security/redactor.ts — 脱敏逻辑（冷层需要在脱敏前捕获原文）
- docs/specs/vm2-001-recall-protocol.md — deep_recall 协议定义
- docs/specs/vm2-002-data-model-boundary.md — raw archive 层规格

## 实现要求

### Repository 扩展
- createRawArchive(archive: RawArchive): 创建归档
- getRawArchive(id: string): 获取归档
- searchRawArchives(query, project, limit): BM25 搜索归档内容
- getRawArchiveByHash(contentHash, tenantId): hash 去重查询
- listRawArchives(project, type, limit): 列表查询

### Archive Service
路径：新增 src/core/archive-service.ts
- ArchiveService 类
- store(content, archiveType, project, metadata): 存入冷层
  - 计算 content_hash（SHA-256）
  - hash 去重：已存在则跳过
  - 可选关联 source_memory_id
- retrieve(id): 获取单条归档
- search(query, project, limit): BM25 搜索

### Deep Recall 实现
- 替换 routes.ts 中的 501 占位为真实实现
- 调用 ArchiveService.search
- 返回 DeepRecallResponse 格式
- MCP 新增 deep_recall 工具

### Content Hash 去重
- 使用 SHA-256 对 content 计算 hash
- 同一 tenant + 同一 hash 只存一份
- 尝试存入已存在的 hash 时返回已有记录的 id

### 归档类型
- transcript: 会话转录
- discussion: 讨论记录
- design_debate: 设计辩论
- chat_export: 聊天导出
- tool_log: 工具日志
- document: 文档

## 交付物

### 1. ArchiveService 实现
路径：新增 src/core/archive-service.ts

### 2. Repository 扩展
路径：扩展 src/db/repository.ts

### 3. Deep Recall 路由实现
路径：修改 src/api/routes.ts（替换 501 占位）

### 4. MCP deep_recall 工具
路径：扩展 src/mcp/server.ts

### 5. Sync Client 扩展
路径：扩展 src/sync/client.ts（deep_recall 方法）

### 6. 测试
路径：新增 src/tests/archive-service.test.ts
内容：
- 存储和检索测试
- hash 去重测试
- deep_recall API 测试（替换 501 测试为真实测试）
- BM25 搜索测试

## 质量要求
- 先读完所有相关源码再动手
- 不破坏现有功能和测试
- npm run build 通过
- npm test 通过（现有 481 + 新增测试全绿）
- regression guard 的 token/latency 指标不能恶化
