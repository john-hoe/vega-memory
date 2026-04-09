# VM2-001：统一 recall 协议与客户端接入契约

## 背景
Vega Memory 二期开发第一个任务。目标是定义统一的两段式 recall 协议，让 Claude Code / OpenClaw / Hermes 等所有客户端走统一的调用模式，token 预算控制下沉到服务端。

## 重要约束
- 这是【设计 + 规格】任务，【不改现有代码行为】
- 现有 session_start 保持不变，只是在协议层定义新的 mode 参数
- deep_recall 只预留 shape 和错误码，不实现（等 VM2-006）

## 当前架构（必须先读代码确认）
- src/core/session.ts — sessionStart() 实现，有 SESSION_BUDGET_RATIOS，tokenBudget 默认 2000
- src/core/types.ts — SessionStartResult、Memory、SearchResult 等类型
- src/core/recall.ts — RecallService.recall() 实现
- src/mcp/server.ts — MCP 工具定义（session_start, memory_recall 等）
- src/api/routes.ts — HTTP API 路由（/api/session/start, /api/recall 等）
- docs/API.md — HTTP API 文档

## 协议设计要求

### session_start(mode: light | standard)
- standard：映射到当前行为，完全兼容，不改任何逻辑
- light：最小安全上下文，包含：
  - preferences（按 importance 排序）
  - active_tasks
  - critical_conflicts（verified === conflict）
  - proactive_warnings
  - token_estimate
  - 轻预算上限：建议 tokenBudget * 0.25（即默认 500 tokens）
  - 【不包含】context、relevant、recent_unverified、wiki_pages

### recall
- 继续做当前热层语义召回，不变
- 在协议文档中明确 recall 的输入/输出 shape

### deep_recall（预留）
- 定义 request/response shape
- 定义错误码：501 Not Implemented（实现等 VM2-006）
- 用途：从冷存档拉原文/证据，默认不注入 session context

### session_end
- 不变，补充与两段式协议的关系说明

## 5 个交付物

### 1. 协议规格文档
路径：docs/specs/vm2-001-recall-protocol.md
内容：完整的协议定义，包括两段式调用流程图、每个 endpoint 的 request/response shape、token budget 策略、错误码

### 2. TypeScript 类型定义
路径：扩展 src/core/types.ts
内容：
- SessionStartMode 类型
- 扩展 session_start 的参数类型，增加 mode 字段（默认 standard 保持兼容）
- DeepRecallRequest / DeepRecallResponse 类型（预留）
- RecallProtocolError 类型

### 3. MCP schema 设计
路径：在规格文档中描述 session_start tool 的新 schema
内容：session_start 增加 mode 参数，默认值 standard

### 4. HTTP API 契约更新
路径：docs/API.md
内容：
- /api/session/start 增加 mode 参数说明
- /api/deep-recall 预留端点定义（返回 501）
- request/response 示例

### 5. 客户端调用规则 Trigger Matrix
路径：包含在 docs/specs/vm2-001-recall-protocol.md 中
内容：定义 Claude Code / OpenClaw / Hermes 各自：
- 什么时候调 session_start(light) vs session_start(standard)
- 什么时候调 recall
- 什么时候调 deep_recall
- session_end 的触发时机

## 质量要求
- 先读完所有相关源码再动笔
- 类型定义必须与现有代码兼容（不破坏任何现有测试）
- 写完后运行 npm run build 确认编译通过
- 运行 npm test 确认所有测试通过
- 如果遇到架构决策问题，用 ask-claude 反问确认
