# VM2-024：统一 HTTP API 与 MCP recall 输出 shape

## 背景
VM2-001 发现 HTTP /api/recall 返回完整 memory metadata + scoring，MCP memory_recall 返回缩减版。两个接口的输出 shape 不一致违反统一协议目标。

## 重要约束
- 定义 canonical recall response shape
- 让 HTTP 和 MCP 对齐到同一个 shape
- 不破坏现有客户端（兼容性优先）

## 必须先读的代码
- src/api/routes.ts — POST /api/recall 路由，看当前返回的完整 shape
- src/mcp/server.ts — memory_recall 工具，看当前返回的缩减 shape
- src/core/recall.ts — RecallService.recall() 返回的 SearchResult
- src/core/types.ts — SearchResult 类型定义
- docs/specs/vm2-001-recall-protocol.md — canonical recall response 定义

## 实现要求

### 确定 Canonical Shape
从 VM2-001 协议文档中已定义的 canonical response item：
- id, type, project, title, content
- importance, source, tags
- created_at, updated_at, accessed_at, access_count
- status, verified, scope, accessed_projects
- similarity, finalScore

### 对齐 MCP 输出
当前 MCP memory_recall 只返回 id, title, content, type, similarity, project。
需要扩展到 canonical shape，保持字段命名一致。

### 对齐 HTTP 输出
当前 HTTP 已返回较完整的数据，确认是否完全匹配 canonical shape，补齐缺失字段。

### 序列化函数
创建统一的 serializeRecallResult() 函数，HTTP 和 MCP 都调用它。

## 交付物
1. 统一序列化函数
2. MCP memory_recall 输出扩展
3. HTTP /api/recall 输出对齐
4. 测试：验证两个接口返回相同 shape

## 质量要求
- npm run build 通过
- npm test 通过
- MCP 和 HTTP 返回完全相同的字段集合
