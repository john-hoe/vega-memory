# P5-006 Value Judgment Rules

## 这份文档是干什么的

这份文档只回答一件事：

当前 Vega 是怎么判断一个 candidate 值不值得留下的，  
这套判断现在已经做到哪了，后面还要怎么收口。

## 先说现状

现在不是完全没有判断逻辑。

当前代码已经有：

- `policy.ts`
- `evaluator.ts`
- `calculatePromotionScore.ts`

它们一起说明两件事：

1. 已经有一版可运行的判断基线
2. 但这套东西还没有完全收成一个统一口径

## 当前已经存在的正式判断信号

按当前代码，正式在 promotion 主线上生效的主要是：

- manual trigger
- age rule
- sufficient ack rule

这些不是设想，而是已经在 policy / evaluator 主线上真的在跑。

## evaluator 现在在做什么

evaluator 现在不是自己发明规则。  
它的职责更像：

- 收集 candidate
- 收集 ack 历史
- 把上下文交给 policy

也就是说：

- policy 决定“怎么判”
- evaluator 负责“把判断需要的上下文凑齐”

这个边界要保留。

## `calculatePromotionScore.ts` 现在该怎么理解

它现在可以看成一个局部 helper。

意思不是它没用，  
而是它现在还不等于整套 value judgment 已经定稿。

更准确地说：

- 它可以作为后续 scoring 规则的一个输入或实现基线
- 但不能拿它反推说“Phase 5 的判断系统已经完整结束了”

## P5-006 真正要收什么

### 1. 正式信号清单

要把哪些东西算正式判断信号写清楚。

例如：

- age
- ack
- manual
- 后续可扩展 scoring

### 2. 解释方式

value judgment 不能只给最终动作。  
还得能说清：

- 为什么 promote
- 为什么 hold
- 为什么 discard

### 3. 可继续收敛

不同项目、不同事件类型，  
后面可能需要不同规则。

所以这里要收的是：

- 规则边界
- 解释边界
- 配置边界

不是现在就把所有数字永远写死。

## 当前不该做的事

下面这些现在都不该混进来：

- 宿主侧判断价值
- 神秘不可解释的大模型黑盒评分
- retrieval ranking 反馈回路
- usage.ack 反馈闭环

这些不是这一层现在要收的重点。

## 一句话版本

`P5-006` 现在要做的，是把当前已经存在的判断规则和局部 score helper 收成一套能解释、能扩展、但不乱吹“已经终局完成”的规则。
