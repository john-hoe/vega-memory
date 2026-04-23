# P7-011 usage.ack Feedback Loop v1

## 这份文档是干什么的

这份文档只回答一件事：

当宿主对某次 memory usage 产生明确反馈时，`usage.ack` 应该如何作为一类 result event 回流给 Vega，并且只影响后续 retrieval / judgment 的有限面，不把宿主重新做重。

## 核心原则

### 1. `usage.ack` 是 feedback event，不是宿主直接改 memory

宿主负责发出：

- `memory_id`
- `context`
- `accepted / rejected / reranked`

Vega 负责：

- 吸收 usage 信号
- 更新 usage 统计
- 决定是否影响 ranking / judgment

### 2. feedback 只能影响 bounded surfaces

`usage.ack` 可以影响：

- retrieval prior
- ranking bias
- value-judgment 的辅助统计

不应该直接影响：

- host 下一步动作
- promotion 的强制判决
- memory 最终类型

## 输入面

最小输入建议为：

| 字段 | 说明 |
| --- | --- |
| `memory_id` | 被消费的 memory / bundle item 标识 |
| `ack_type` | `accepted` / `rejected` / `reranked` |
| `context` | 使用场景，如 query / intent / host surface |
| `session_id` | 会话标识 |
| `event_id` | 幂等键 |
| `ts` | 时间戳 |

## 处理语义

- `accepted`：说明当前 memory 对这次任务推进有效
- `rejected`：说明该 memory 对这次任务不适合
- `reranked`：说明该 memory 相关，但顺序/权重应调整

## 输出面

Vega 吸收后至少应更新：

- per-memory usage counters
- recent acceptance / rejection window
- retrieval-side bounded feedback signals
- metrics aggregation input

## 与 Phase 7 的关系

`usage.ack` 属于 `Use / Event Backflow`，
不属于 `存储层`。

所以它应被放在：

- Phase 7 Event Backflow family

而不是：

- raw storage
- promotion storage contract

## 反模式

1. 宿主直接用 `usage.ack` 改写最终 memory
2. `usage.ack` 没有幂等键，重放不可控
3. `usage.ack` 越层影响 host runtime 决策

## 一句话版本

`P7-011` 要做的，是把宿主对 memory 使用效果的显式反馈，收成一条 bounded、可回流、可统计、但不越层的 usage event loop。
