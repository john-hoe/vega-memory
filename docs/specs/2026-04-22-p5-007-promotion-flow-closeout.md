# P5-007 Promotion Flow Closeout

## 这份文档是干什么的

这份文档只回答一件事：

candidate 到 promoted 这条流现在到底是怎么走的，  
哪些动作已经存在，哪些边界必须保住，后面还缺什么。

## 当前主线已经存在

按现在代码，promotion flow 已经有真实主线：

1. 读取 candidate
2. evaluator 调 policy
3. 拿到 decision
4. orchestrator 执行动作
5. 写 audit

这条线已经不是草图，而是现有代码主线。

## 现在已经支持的动作

当前主线已经支持：

- promote
- hold
- discard
- demote

所以 `P5-007` 现在的重点，  
不是“再定义有没有 promotion flow”，  
而是把这条流的边界和责任写清楚。

## promote 路径现在怎么走

如果 decision 是 promote：

- `createFromCandidate()`
- candidate 删除
- promoted memory 进入正式 `memories`
- 写 promotion audit

这说明 promote 现在已经是一个完整动作，  
不是只是改一个状态位。

## demote 路径现在怎么走

如果是 manual demote：

- promoted memory 用同一个 id 回到 candidate
- candidate 回到 `held`
- 正式 memory 行删除
- 写 promotion audit

这里最重要的一点是：

**candidate 和 promoted 可以复用同一个 id。**

这条边界现在要保住。

## 为什么 id 复用很重要

因为这样：

- lineage 清楚
- audit 容易串
- promotion / demotion 不会长出第二套身份

如果后面有人想改掉这条规则，  
必须先证明不会把审计和 lineage 搞乱。

## audit 在这条流里不是可选项

只要有：

- promote
- hold
- discard
- demote

这些动作，audit 就必须存在。

所以 Phase 5 这里要保留一个明确口径：

- promotion audit 是主线组成部分
- 不是“做完功能后顺手记一下日志”

## 当前还没有完全收清的地方

### 1. flow 的文案口径

现在代码主线是清楚的，  
但文档层还需要把：

- 哪些动作对应什么状态变化
- 哪些动作会生成正式 memory
- 哪些动作只停留在 candidate 层

说得更统一。

### 2. rejection / hold / discard 的业务解释

现在这些动作已经存在，  
但还需要更稳定的业务语言。

### 3. runtime 外围能力

例如：

- retrieval API
- ranking feedback
- usage.ack 回流

这些都不是 `P5-007` 现在要收口的东西。

## 一句话版本

`P5-007` 现在要做的，是把当前已经存在的 promotion / demotion / audit 主线收成一套不打架、能继续往下拆的流程规则。
