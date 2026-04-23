# P6-004 Retrieval Observability v1

## 这份文档是干什么的

这份文档只回答一件事：

Phase 6 的 retrieval 系统，应该被怎么观察、怎么衡量、怎么发现失控或退化。

## 核心原则

### 1. Observability 不是“有日志就算了”

retrieval 至少要回答：

- 这次到底取了什么
- 花了多少 token
- 哪些 source 真正起作用了
- 有没有 fallback
- 有没有进入错误模式

### 2. 指标服务于产品判断

Phase 6 的 observability 不是只给工程师看延迟，  
还要支持判断：

- bundle 是否够密
- source 是否被浪费
- followup 是否在失控

## P6-004.1 核心指标

### P6-004.1.1 retrieval token efficiency metric

这个指标回答：

**取回来的 token 里，有多少真正变成了有用 bundle。**

它不是简单 token 总量，  
而是效率信号。

### P6-004.1.2 source utilization metric

这个指标回答：

**被选进来的 source，有多少真的贡献了 record。**

否则会出现：

- source fanout 很大
- 但真正有贡献的 source 很少

### P6-004.1.3 bundle coverage metric

这个指标回答：

**当前 bundle 是否覆盖了这次 intent 期望的关键面。**

这不是 usage sufficiency，  
而是 retrieval 输出完整性的 proxy。

## P6-004.2 compliance / miss signals

### P6-004.2.1 missing retrieval trigger signal

这个信号回答：

**按当前上下文本该触发 retrieval，但宿主没有触发。**

它帮助识别“宿主漏取”。

### P6-004.2.2 skipped bundle signal

这个信号回答：

**Vega 已经返回 bundle，但宿主没有真正消费它。**

它帮助识别“取了但没用”。

### P6-004.2.3 repeated followup inflation signal

这个信号回答：

**同一条 retrieval lineage 正在通过 repeated followup 无限膨胀。**

这条信号应该和 `P6-003` 的 followup guardrails 联动。

## 最低可观测输出

Phase 6 至少要能在 retrieval 结果或日志里看到：

- `used_sources`
- `fallback_used`
- `confidence`
- `bundle_digest`
- `checkpoint_id`
- token 估计
- warnings

## 观测对象分层

### 1. request-level

看单次 retrieval：

- intent
- mode
- query_focus
- host_hint 是否提供
- latency
- token

### 2. bundle-level

看 bundle 结果：

- sections 数
- records 数
- source 分布
- fallback 是否发生

### 3. lineage-level

看一条 retrieval 链：

- followup 次数
- bundle 是否越来越大
- 有没有反复 miss

## 不属于 P6-004 的内容

下面这些不在这份文档里：

- alert threshold 的最终运维策略
- usage 层 sufficiency metric
- execution observability

这些分别属于：

- 后续 ops
- `Phase 7`

## 一句话版本

`P6-004` 要做的，是把 Phase 6 的 retrieval 从“能跑”推进到“能看见它为什么跑对、什么时候跑偏、什么时候已经开始浪费”。 
