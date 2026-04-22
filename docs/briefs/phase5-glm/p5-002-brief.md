# [PLANNING] P5-002 设计 Vega Layered Ingestion Workflow v1

> **This is a parent task for planning only.** Do not execute directly.
> Complete the child tasks below in dependency order.

## Scope

- Wave: 5B Vega Layered Ingestion
- Group: B 分层摄取
- Priority: P0
- Value: 高
- Depends on: P5-001

## Objective

把 raw event、candidate、promoted、wiki/fact/insight 的层级与流转规则正式定义下来。

## Child Tasks

| ID | Task | Prio | Status |
|---|---|---|---|
| P5-002.1 | 定义 raw inbox retention 与 replay 策略 | P0 | ⏳ |
| P5-002.2 | 定义 candidate layer schema 与状态转换 | P0 | ⏳ |
| P5-002.3 | 定义 promoted layer schema 与 recall 可见性 | P0 | ⏳ |

## Execution Order

1. **P5-002.1** 定义 raw inbox retention 与 replay 策略 (no blocker)
2. **P5-002.2** 定义 candidate layer schema 与状态转换 (no blocker)
3. **P5-002.3** 定义 promoted layer schema 与 recall 可见性 (no blocker)
