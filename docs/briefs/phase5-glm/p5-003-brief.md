# [PLANNING] P5-003 定义 candidate memory 提取与 promotion 准则

> **This is a parent task for planning only.** Do not execute directly.
> Complete the child tasks below in dependency order.

## Scope

- Wave: 5C Retrieval & Promotion
- Group: C 检索与晋升
- Priority: P0
- Value: 高
- Depends on: P5-002

## Objective

区分 raw event、candidate memory、promoted memory，明确晋升条件与 recall 可见性。

## Child Tasks

| ID | Task | Prio | Status |
|---|---|---|---|
| P5-003.1 | 定义 wiki / fact / insight 派生链路 | P1 | ⏳ |
| P5-003.2.1 | 设计 promotion → retrieval 反馈信号模型 | P1 | ⏳ |
| P5-003.2.2 | 实现 promotion feedback 写入与 retrieval 权重更新 | P2 | ⏳ |
| P5-003.3.1 | 设计人工复核与 override API | P2 | ⏳ |
| P5-003.3.2 | 实现人工复核队列与 override 端点 | P2 | ⏳ |

## Execution Order

1. **P5-003.1** 定义 wiki / fact / insight 派生链路 (after P5-002)
2. **P5-003.2.1** 设计 promotion → retrieval 反馈信号模型 (after P5-003.1.1.2)
3. **P5-003.2.2** 实现 promotion feedback 写入与 retrieval 权重更新 (after P5-003.2.1)
4. **P5-003.3.1** 设计人工复核与 override API (after P5-003.1.3.2)
5. **P5-003.3.2** 实现人工复核队列与 override 端点 (after P5-003.3.1)
