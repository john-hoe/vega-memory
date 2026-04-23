# [PLANNING] P6-002 设计 Vega Retrieval Orchestration v1

> **This is a parent task for planning only.** Do not execute directly.
> Complete the child tasks below in dependency order.

## Scope

- Wave: 6B Vega Retrieval Orchestration
- Group: B 检索编排
- Priority: P0
- Value: 高
## Objective

把 Vega 内部 retrieval orchestration 的 source 选择、fallback 规则和 feedback 边界整理成统一执行框架。

## Child Tasks

| ID | Task | Prio | Status |
|---|---|---|---|
| P6-002.1 | 定义 source selection、query rewrite 与 query_focus 路由 | P0 | ⏳ |
| P6-002.2 | 定义 retrieval fallback 边界 | P0 | ⏳ |
| P6-002.3 | 定义 promotion 对 retrieval 的反馈规则 | P1 | ⏳ |

## Execution Order

1. **P6-002.1** 定义 source selection、query rewrite 与 query_focus 路由 (no blocker)
2. **P6-002.2** 定义 retrieval fallback 边界 (no blocker)
3. **P6-002.3** 定义 promotion 对 retrieval 的反馈规则 (no blocker)
