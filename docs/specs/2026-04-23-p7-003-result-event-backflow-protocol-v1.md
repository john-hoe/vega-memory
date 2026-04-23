# P7-003 Result Event Backflow Protocol v1

## 这份文档是干什么的

这份文档只回答一件事：

宿主在执行过程中产生的新结果事件，应该如何持续、可靠地回流给 Vega，而不把宿主重新做成 memory intelligence layer。

## 核心原则

### 1. 宿主回流的是结果事件，不是最终 memory

宿主负责：

- 捕获事件
- 结构化事件
- 投递与补发

宿主不负责：

- 判断这是不是高价值 memory
- 决定是否 promotion
- 决定 wiki / fact / insight 派生

### 2. 先保证可靠，再谈聪明

Phase 7 的 backflow 优先保证：

- 不悄悄丢
- 可重试
- 可补发
- 可观察

### 3. 回流面必须有最小类型集

没有最小事件集，就不会有稳定的 host-side usage loop。

## P7-003.1 最小事件集合

### P7-003.1.1 实时回流事件集合

以下事件应尽量实时回流：

- `task_update`
- `decision_signal`
- `pitfall_signal`
- `session_start`
- `session_end`
- explicit remember / preference 类信号

原因是：

- 这些事件密度高
- 对后续 usage / retrieval 价值直接
- 不适合长时间滞留在宿主内存里

### P7-003.1.2 缓冲回流事件集合

以下事件允许缓冲后批量回流：

- `tool_result`
- `command_output`
- `file_change`
- `assistant_message`
- `doc_snippet`

缓冲的目标不是说它们不重要，
而是减少写入频率、降低宿主开销。

### P7-003.1.3 回流失败的队列、重试与幂等规则

backflow 至少应具备：

- 本地队列
- 幂等 `event_id`
- retry
- flush
- 离线缓存
- 批量补发

失败规则：

- 发失败不能静默丢
- 可延迟，但不能无痕消失
- 能发就发，发不了就入队

## P7-003 到 Vega 的职责边界

宿主负责：

- 结果事件 capture
- 薄结构化
- 脱敏
- 投递

Vega 负责：

- raw inbox
- dedup
- candidate extraction
- promotion
- derivation

## 与 P7-011 的关系

`usage.ack feedback loop` 属于 Phase 7 的 event backflow family，
但它是一个独立 implementation lane，不把它塞进 `P7-003.1` 的最小事件面里。

也就是说：

- `P7-003` 先把 backflow protocol 立住
- `P7-011` 再实现 `usage.ack` 这条具体反馈链

## 反模式

1. 宿主先判断“值不值得存”再决定发不发
2. 只在任务结束时一次性大回流
3. `tool_result / command_output / file_change` 大量静默丢失
4. 没有 `event_id`，导致重试去重不可控

## 一句话版本

`P7-003` 要做的，是把宿主执行过程中的新结果事件持续、可靠地送回 Vega，而不把长期价值判断放回宿主侧。
