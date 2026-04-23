# P7-004 Host Runtime Gating v1

## 这份文档是干什么的

这份文档只回答一件事：

Phase 7 的 usage workflow，在不同宿主能力层级下，到底能被约束到什么程度。

## 核心原则

### 1. 约束强度是分层的

不是所有宿主都能一开始就做到 runtime hard gate。

Phase 7 先承认三个约束层级：

- Level 1 `Capability only`
- Level 2 `Soft protocol`
- Level 3 `Runtime gate`

### 2. gate 的目标是防止 “取了但没用”

P7-004 不控制 chain-of-thought，
它只控制 usage workflow 的合法状态转换。

## P7-004.1 Level 1 Capability only

Level 1 只要求：

- 宿主有 retrieval 接口
- 宿主有 checkpoint 结构
- 宿主能把结果事件回流 Vega

但它不能真正阻断：

- checkpoint 缺失时的 execution
- bundle 被跳过

它更像：

- 有能力
- 能记录
- 不能强制

## P7-004.2 Level 2 Soft protocol

Level 2 依赖：

- rules
- AGENTS
- prompts
- workflow discipline

它可以：

- 强提示必须 checkpoint
- 记录 violation
- 统计 skipped bundle

但仍不能从 runtime 层彻底阻断执行。

## P7-004.3 Level 3 Runtime gate

Level 3 是理想形态：

- 没有 checkpoint，不允许进入 `execution_allowed`
- retrieval -> checkpoint -> execution 成为硬状态机
- checkpoint 失败时直接返回协议错误

这层才真正解决：

- retrieval 结果被直接跳过
- bundle 被形式化消费但没有真实 grounding

## 统一状态机

无论在哪个 level，宿主可观察状态都建议统一成：

```text
bundle_received
-> checkpoint_required
-> checkpoint_submitted | checkpoint_missing | checkpoint_invalid
-> execution_allowed | followup_required | external_required
```

Level 1 / 2 主要做记录，
Level 3 才把非法状态真正挡住。

## 与 Phase 7 其他任务的关系

- `P7-001.1` 定义 checkpoint 协议
- `P7-004` 定义这些协议怎样在宿主侧被约束
- `P7-005` 负责把这些约束是否真的生效做成可观测指标

## 反模式

1. 只有协议，没有任何违反信号
2. 明明是 Level 1 / 2，却假装已经 runtime hard gate
3. gate 做得过重，反过来把宿主实现复杂度炸掉

## 一句话版本

`P7-004` 要做的，是明确 Phase 7 usage workflow 在不同宿主能力下的约束强度，而不是假装所有宿主都已经具备 runtime hard gate。
