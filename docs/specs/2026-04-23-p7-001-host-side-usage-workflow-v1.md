# P7-001 Host-side Usage Workflow v1

## 这份文档是干什么的

这份文档只回答一件事：

宿主在拿到 Vega 返回的 `context bundle` 之后，应该如何真正消费它、如何判断当前是否足够推进一步，以及什么时候把控制权交给 fallback 或 event backflow。

Phase 7 不是再讨论“怎么取”，
而是把 `retrieval -> usage -> execution` 这条桥补完整。

## 核心原则

### 1. Host consumes context, Vega owns memory semantics

宿主负责：

- 消费 bundle
- 形成当前工作事实基线
- 判断 `sufficient / needs_followup / needs_external`
- 在执行过程中持续回流新结果事件

Vega 负责：

- memory semantics
- 长期价值判断
- promotion / derivation
- retrieval intelligence

一句话：

**宿主负责怎么用，Vega 负责这些东西长期意味着什么。**

### 2. 先消费 bundle，再开始大段 thinking / execution

retrieval 成功并不等于 usage 已发生。

在 Phase 7 里，宿主必须先显式完成一次 bundle consumption checkpoint，
然后才允许进入：

- 长段 reasoning
- 大范围代码改动
- 外部工具调用
- 最终回答

### 3. 能推进就先推进，不为完美上下文无限扩张

宿主的判断标准不是：

- “我是不是已经知道得最全”

而是：

- “我是不是已经知道得足够往前推进一步”

### 4. Usage 不重写 retrieval 策略

宿主只判断：

- 当前够不够
- 不够时是 `needs_followup` 还是 `needs_external`

宿主不负责：

- 决定下一次 retrieval primitive
- 设计 source selection
- 设计 ranking / compression / fallback 细节

## P7-001.1 Bundle Consumption Checkpoint

### P7-001.1.1 checkpoint 必填字段与最小有效性

每次 bundle consumption checkpoint 至少包含：

| 字段 | 说明 |
| --- | --- |
| `bundle_id` | 本次 retrieval 返回 bundle 的唯一标识 |
| `decision_state` | `sufficient` / `needs_followup` / `needs_external` 三态之一 |
| `used_items` | 宿主本次实际消费并依赖的 bundle 条目 |
| `working_summary` | bundle 被宿主吸收后的当前事实基线 |

最小有效性规则：

- `bundle_id` 必填
- `decision_state` 必填，且只能取三态之一
- `used_items` 在 bundle 非空时不能是空数组
- `working_summary` 不能为空，且不能只是 bundle summary 原样复制

### P7-001.1.2 checkpoint 提交时机与消费顺序

checkpoint 的标准顺序固定为：

1. 收到 bundle
2. 读取 `summary`
3. 读取 `warnings`
4. 读取 `active_tasks / decisions / pitfalls`
5. 读取 `wiki_hits / relevant_memories`
6. 输出 checkpoint
7. 再进入 execution / followup / external

也就是说：

- retrieval 之后先 checkpoint
- checkpoint 之后再做大段 execution

### P7-001.1.3 checkpoint 失败、重试与低置信处理

以下情况视为 checkpoint 失败：

- 结构字段缺失
- `decision_state` 非法
- `used_items` 与 bundle 明显不一致
- `working_summary` 无法形成有效工作事实

处理规则：

- 结构错误：直接拒绝，要求重提
- 消费证据弱但结构合法：允许继续，但记录 `low_confidence_checkpoint`
- 宿主未提交 checkpoint 就试图 execution：记录 violation；若 runtime gate 存在，则直接阻断

## P7-001.2 Usage Sufficiency Decision Model

### P7-001.2.1 `sufficient` 判定样例与边界

判为 `sufficient` 的最低条件：

- 当前已有明确下一步动作
- 当前阻塞已不再是信息缺口
- 当前 bundle 足以支撑一轮回答、执行、编码或分析

典型样例：

- 已命中直接相关的 decision / pitfall，可以开始改代码
- 已有稳定的当前任务上下文，可以继续昨天的工作
- 当前回答只需要 bundle 内已有结论，不需要额外 repo 或外部证据

不应误判成 `sufficient` 的情况：

- 命中的只是泛泛摘要，没有执行所需细节
- 仍然缺关键配置、日志、实现状态
- 仍然缺原始证据或最新外部行为

### P7-001.2.2 `needs_followup` 判定样例与边界

判为 `needs_followup` 的最低条件：

- 当前确实还有信息缺口
- 该缺口仍可能在 Vega 内部知识中补足
- 不需要立即转向本地 repo 或外部来源

典型样例：

- 已知有历史决策，但还差更具体的上一轮结论
- 已命中相关 wiki 主题，但需要更窄一层的内部补取
- 当前只缺更深的 memory / archive / provenance，而不是环境事实

不应误判成 `needs_followup` 的情况：

- 缺的是当前分支真实代码
- 缺的是测试失败日志
- 缺的是最新 SDK/API 文档

### P7-001.2.3 `needs_external` 判定样例与边界

判为 `needs_external` 的最低条件：

- 当前缺口已经不适合再用 Vega 内部知识补足
- 缺口属于本地 workspace 或外部时效信息

典型样例：

- 需要读当前 repo 文件
- 需要看测试日志、运行状态、环境配置
- 需要官方文档、GitHub issue、第三方 SDK 最新行为

`needs_external` 不是失败，
而是明确交给 Usage Fallback Ladder 的 handoff。

## 最小 Usage 状态流

```text
bundle_received
-> bundle_consumed
-> sufficient | needs_followup | needs_external
-> execution | followup | fallback
-> result_events_emitted
```

`bundle_consumed` 是整条链的 gate。

## 反模式

以下行为在 Phase 7 里都算反模式：

1. 取了 bundle 但没有 checkpoint
2. checkpoint 只形式化打卡，没有真实 `used_items`
3. 明明已经够推进，却继续无限补取
4. 明明需要本地/外部信息，却还在 Vega 内部硬 followup
5. 用宿主自己的强判断替代 Vega 的 memory semantics

## 一句话版本

`P7-001` 要做的，是把宿主对 Vega bundle 的消费变成一个真实的 workflow gate：先消费，再判断三态，再决定继续执行、补取还是升级。
