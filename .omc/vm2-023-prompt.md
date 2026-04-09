# VM2-023：实现 light 模式实际 budget 裁剪逻辑

## 背景
VM2-001 定义了 session_start(mode: light | standard) 协议，代码已接受 mode 参数，但 light 模式目前仍走 standard 逻辑。需要实现真正的 light 裁剪。

## 重要约束
- standard 模式行为完全不变
- light 模式只加载最小安全上下文
- light budget 上限：tokenBudget * 0.25（默认 500 tokens）

## 必须先读的代码
- src/core/session.ts — sessionStart() 完整实现，特别是 budget 裁剪逻辑（takeMemoriesWithinBudget）
- src/core/types.ts — SessionStartMode, SessionStartResult
- docs/specs/vm2-001-recall-protocol.md — light 模式定义：
  - 包含：preferences, active_tasks, critical_conflicts, proactive_warnings, token_estimate
  - 不包含：context, relevant, recent_unverified, wiki_pages

## 实现要求

### Light Mode 裁剪
在 session.ts 的 sessionStart() 中，当 mode === "light" 时：
- 只查询 preferences（按 importance DESC）
- 只查询 active_tasks
- 只查询 conflicts（作为 critical_conflicts）
- 只生成 proactive_warnings
- 不查询 context
- 不做 semantic recall（不查 relevant）
- 不查 recent_unverified
- 不查 wiki_pages
- budget 上限：Math.floor(config.tokenBudget * 0.25)
- 返回的 SessionStartResult 中，不包含的字段设为空数组

### Light Budget 分配
- preferences: 30% of light budget
- active_tasks: 40% of light budget
- conflicts: 20% of light budget
- proactive_warnings: 10% of light budget（仅文本，不占大量 token）

### 性能优化
- light 模式应该明显更快（跳过了 semantic recall 和多个 DB 查询）
- 记录 regression guard 指标时标记 mode

## 交付物
1. session.ts light 模式实现
2. 测试：light vs standard 行为差异测试
3. 测试：light budget 不超过 tokenBudget * 0.25

## 质量要求
- npm run build 通过
- npm test 通过
- standard 模式行为与修改前完全一致（回归测试）
- light 模式 token_estimate 明显低于 standard
