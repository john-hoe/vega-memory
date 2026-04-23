# P7-011 实现 usage.ack feedback loop

- Wave: 7D Event Backflow
- Group: 事件回流
- Priority: P1
- Value: 高
- Depends on: P5-007
- Type: implementation

## Context

`usage.ack` 是 Phase 7 Event Backflow 里的实现型任务。它要把宿主对 memory 使用效果的显式反馈，收成一条 bounded、可统计、可用于后续 retrieval/judgment 的 feedback event。

## Acceptance Criteria

- **Artifact**: `src/feedback/usage-ack-handler.ts`
- **Spec**: `docs/specs/2026-04-23-p7-011-usage-ack-feedback-loop-v1.md`
- **Command**: `test -f src/feedback/usage-ack-handler.ts`
- **Assertion**: 实现 `usage.ack` 的 handler / ingestion path，能接收 `memory_id + ack_type + context + event_id` 并更新 usage 统计或反馈输入面。
- **Output**: `usage.ack feedback loop 可被 runtime 消费，并作为 bounded event 进入 Vega。`

## Steps

1. 建立 `usage.ack` 输入 shape 与 handler
2. 写入 usage 统计/反馈吸收面
3. 保持其只影响 bounded surfaces，不越层改 host runtime 决策
4. 增加对应测试和最小 observability

## Verification

```bash
test -f docs/specs/2026-04-23-p7-011-usage-ack-feedback-loop-v1.md
test -f src/feedback/usage-ack-handler.ts
```
