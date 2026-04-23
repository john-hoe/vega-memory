# P6-003 Retrieval Token Guardrails v1

## 这份文档是干什么的

这份文档只回答一件事：

retrieval 在 Phase 6 里，怎么做到：

- token-bounded
- 不无界扩张
- 该深的时候深
- 该省的时候省

## 核心原则

### 1. Retrieval 必须 token-bounded

“取”不是越多越好。  
目标是：

**高密度 bundle，而不是大体积上下文。**

### 2. budget 是 product rule，不只是工程优化

token guardrails 不是后面再调的实现细节，  
而是 retrieval contract 的一部分。

## P6-003.1 bundle budgets

### P6-003.1.1 bootstrap token budget

`bootstrap` 需要广一点，但不能无界。

建议默认规则：

- 优先摘要，不优先长原文
- source fanout 有上限
- 单次 bundle 的 section 数受控
- 先保证“能开工”，再追求“知道所有东西”

### P6-003.1.2 lookup / followup / evidence budgets

三种 intent 不应该共用一个预算模型：

| intent | 预算倾向 |
| --- | --- |
| `lookup` | 窄、快、定向 |
| `followup` | 比 lookup 更紧，只补缺口 |
| `evidence` | 允许更贵，但 source 更少、provenance 更强 |

### P6-003.1.3 summary-first 与 snippet depth policy

retrieval 默认优先：

- summary
- headline
- 短 snippet

只有在：

- evidence intent
- 明显需要原文
- summary 不足以支持判断

时，才提高 snippet depth。

## P6-003.2 followup guardrails

### P6-003.2.1 followup 允许触发条件

只有这些情况才允许 followup：

- 上一轮 bundle 已消费
- 缺口被明确识别
- 缺口仍属于 retrieval 可解决范围

### P6-003.2.2 followup 禁止重复触发模式

下面这些属于反模式：

- 没消费 bundle 就继续 followup
- 同一个 query 重复补取但没有新约束
- source 已经见底还继续机械扩张
- 把 usage 不足误当 retrieval 不足

### P6-003.2.3 cooldown / max_followups / 升级条件

Phase 6 至少要定 3 条硬规则：

1. `cooldown`
   - 同一 retrieval lineage 不应在极短间隔内无限触发

2. `max_followups`
   - 一条 lineage 最多允许有限次 followup

3. `升级条件`
   - 达到上限后，不再继续 retrieval 扩张
   - 转成更明确的：
     - `needs_external`
     - 或进入 usage fallback

## guardrail 该约束什么

Phase 6 的 token guardrails 至少要约束：

- 总 token 预算
- 每个 source 的 fanout
- section 数量
- 每条 record 的 snippet 深度
- followup 次数

## 不属于 P6-003 的内容

下面这些不在这份文档里：

- ranking 规则本身
- observability 指标定义
- usage sufficiency

这些分别属于：

- `P6-002`
- `P6-004`
- `Phase 7`

## 一句话版本

`P6-003` 要做的，是把 retrieval 的 token、深度和 followup 扩张收成一套真正可执行的 guardrails，而不是靠经验拍脑袋。
