# VM2-011：提供显式分层 recall 模式 L0 / L1 / L2 / L3

## 背景
VM2-001 定义了 light/standard 两段式协议，VM2-023 实现了 light 模式裁剪，VM2-005 实现了 fact claims，VM2-006 实现了 deep_recall。现在把当前隐式 session bundle 产品化为显式层级，便于不同 agent 接入并控制默认注入策略。

## 必须先读的代码
- src/core/session.ts — sessionStart light/standard 实现
- src/core/recall.ts — recall 实现
- src/core/archive-service.ts — deep_recall 实现
- src/core/fact-claim-service.ts — fact claims
- docs/specs/vm2-001-recall-protocol.md — 协议定义

## 实现要求

### 显式层级定义
- L0: Identity（preferences only，最小化，~50 tokens）
- L1: Light（= 当前 light 模式：preferences + tasks + conflicts + warnings）
- L2: Standard（= 当前 standard 模式：完整 session bundle）
- L3: Deep（L2 + deep_recall 原文证据拉取）

### session_start 扩展
- mode 参数扩展：L0 | L1 | L2 | L3 | light | standard
- light 映射到 L1，standard 映射到 L2（向后兼容）
- L0 只返回 preferences（budget 极低）
- L3 在 L2 基础上自动触发 deep_recall

### MCP/API
- session_start mode 接受新值
- 文档更新

### 类型
- SessionStartMode 扩展

## 交付物
1. session.ts L0/L3 实现
2. types.ts 扩展
3. MCP/API 更新
4. 文档更新
5. 测试

## 质量要求
- npm run build 通过
- npm test 通过
- 现有 light/standard 行为不变
