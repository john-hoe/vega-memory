# P7-005 Usage Observability v1

## 这份文档是干什么的

这份文档只回答一件事：

Phase 7 的 usage workflow 应该被怎么观察、怎么判断是否真正发生了 bundle consumption、fallback、以及 event backflow。

## 核心原则

### 1. Usage 不是有日志就算了

Phase 7 至少要回答：

- bundle 是不是真的被消费了
- 三态判断是如何分布的
- fallback 有没有失控
- backflow 有没有漏发

### 2. 指标服务于产品判断

这些指标不是只给工程师看延迟，
而是要帮助判断：

- 宿主有没有真正使用 Vega
- usage workflow 有没有退化成“取了不看”
- fallback 和 backflow 有没有偏离边界

## P7-005.1 bundle consumption observability

至少需要：

- `bundle_received_count`
- `checkpoint_submitted_count`
- `bundle_consumption_rate`
- `low_confidence_checkpoint_count`
- `skipped_bundle_count`

它们回答的是：

- retrieval 发生了几次
- checkpoint 真的提交了几次
- 宿主有没有把 bundle 真正消费掉

## P7-005.2 fallback observability

至少需要：

- `needs_followup_rate`
- `needs_external_rate`
- `local_fallback_entry_count`
- `external_fallback_entry_count`
- `fallback_resolution_layer`
- `fallback_violation_count`

它们回答的是：

- 缺口主要停在 Vega 内部还是外部
- 宿主是不是动不动就跳外部
- fallback 最终在哪一层获得了推进所需信息

## P7-005.3 event backflow observability

至少需要：

- `emitted_event_count`
- `queued_event_count`
- `retry_count`
- `dropped_event_count`
- `flush_success_rate`
- `event_type_coverage`
- `session_end_backflow_rate`

它们回答的是：

- 宿主有没有持续回流事件
- 失败有没有被补发
- 哪些事件类型在当前宿主上根本没被覆盖

## 指标分层

### request-level

看单次 usage：

- 有没有 checkpoint
- checkpoint 是什么三态
- 有没有进入 fallback

### lineage-level

看一条完整工作链：

- repeated followup 是否膨胀
- fallback 是否反复来回切换
- backflow 是否贯穿整个任务周期

### host-level

看某个宿主整体 compliance：

- skipped bundle 是否偏高
- external fallback 是否异常高
- backflow 覆盖率是否持续偏低

## 反模式

1. 只统计 retrieval token，不统计 usage 是否发生
2. 只知道 fallback 发生了，不知道停在哪一层
3. 只知道事件发过，不知道有没有丢、有没有补发

## 一句话版本

`P7-005` 要做的，是把 Phase 7 的 usage workflow 变成可见的：能看见 bundle 是否被真正消费、fallback 是否失控、backflow 是否可靠。
