# VM2-013：Claude Code / OpenClaw / Hermes adapter 验证

## 背景
VM2-001 定义了统一 recall 协议和 trigger matrix，VM2-011 实现了 L0/L1/L2/L3 分层。现在按统一协议验证三类客户端的接入效果。

## 必须先读的代码
- docs/specs/vm2-001-recall-protocol.md — 协议定义和 trigger matrix
- docs/API.md — HTTP API 文档
- src/mcp/server.ts — MCP 工具定义
- rules/CLAUDE.md — Claude Code 集成规则
- AGENTS.md — Codex 集成规则

## 实现要求

### Claude Code Adapter 文档
- 更新 rules/CLAUDE.md 使用 L0/L1/L2/L3 模式
- 定义何时用 L0（快速跟进）、L1（日常编码）、L2（规划/架构）、L3（审计/证据）
- 包含 deep_recall 调用示例

### OpenClaw Adapter 文档
- 更新 HTTP API 调用模板
- 定义 token 压力下的模式选择策略
- 包含 session_start + recall 两段式示例

### Hermes Adapter 文档
- 预留 adapter 方案
- 定义 orchestration turn 的模式选择
- 定义 delegation handoff 的 session_end 触发时机

### 集成测试
- 模拟 Claude Code 工作流：L1 session_start → recall → store → session_end
- 模拟 OpenClaw 工作流：L0 session_start → aggressive recall
- 验证 token_estimate 在不同 mode 下符合预期

### Token 节省曲线
- 对比 L0/L1/L2/L3 的 token_estimate
- 生成对比报告

## 交付物
1. rules/CLAUDE.md 更新
2. AGENTS.md 更新
3. docs/adapter-guide.md（新增）
4. 集成测试
5. token 对比报告脚本

## 质量要求
- npm run build 通过
- npm test 通过
- 文档更新不破坏现有规则
