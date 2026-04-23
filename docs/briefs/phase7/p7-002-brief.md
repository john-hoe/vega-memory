# [PLANNING] P7-002 设计 Usage Fallback Ladder

> **This is a parent task for planning only.** Do not execute directly.
> Complete the child tasks below in dependency order.

## Scope

- Wave: 7C Usage Fallback Ladder
- Group: 外部升级
- Priority: P0
- Value: 高
- Depends on: P7-001

## Objective

把 `needs_external` 之后的升级路径固定成稳定顺序：先本地，再外部，查到足够推进的信息就停。

## Child Tasks

| ID | Task | Prio | Status |
|---|---|---|---|
| P7-002.1 | 定义本地 workspace fallback 边界 | P1 | 🔧 |
| P7-002.2 | 定义外部信息源 fallback 边界 | P1 | 🔧 |

## Execution Order

1. **P7-002.1** 定义本地 workspace fallback 边界
2. **P7-002.2** 定义外部信息源 fallback 边界
