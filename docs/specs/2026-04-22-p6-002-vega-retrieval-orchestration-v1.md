# P6-002 Vega Retrieval Orchestration v1

## 这份文档是干什么的

这份文档只回答一件事：

Vega 在收到一个 retrieval request 后，内部到底怎么决定：

- 用哪些 source
- 怎么改写 query
- 什么时候 fallback
- 什么时候停止
- 最后怎么组 bundle

## 核心原则

### 1. Retrieval 是统一 workflow，不是很多 primitive 的拼盘

Phase 6 的目标不是让宿主在：

- `session_start`
- `recall`
- `wiki_search`
- `deep_recall`

之间自己选。

而是把这些底层能力收敛到一个统一的：

**`context.resolve` orchestration**

### 2. orchestration 发生在 Vega 内部

宿主不做：

- source 选择
- query rewrite
- ranker 选择
- fallback 策略设计

这些全部留在 Vega。

## retrieval 主线

一条 retrieval orchestration 主线可以收成：

1. 读取 request
2. 归一化 `intent / mode / query_focus / host_hint`
3. 选择 source plan
4. 做 query rewrite
5. 拉取候选结果
6. ranking / merge
7. budget 削减
8. fallback 或 stop
9. 组装 bundle
10. 返回 `checkpoint_id + bundle_digest + bundle`

## P6-002.1 source selection / query rewrite

### P6-002.1.1 bootstrap source plan

`bootstrap` 默认优先取：

- 当前 project 相关长期 memory
- project-level decision / pitfall
- 高价值 wiki 摘要
- 必要的 session continuity 信息

`bootstrap` 不应该默认直接拉：

- 大体积 cold evidence
- 所有 archive
- 无界外部 source

### P6-002.1.2 lookup 的 history/docs/mixed biasing

`lookup` 的 source biasing 应该可表达：

- `history`：优先 session/project 内历史上下文
- `docs`：优先 wiki / structured docs
- `mixed`：历史与文档并取

但 biasing 是：

- source prior
- 排序倾向

不是强制只查一个 source。

### P6-002.1.3 evidence mode 路由边界

`evidence` intent 需要：

- provenance 更强
- 原文更完整
- 摘要压缩更保守

所以 evidence 路由应优先：

- archive / cold evidence
- 高可信 provenance 记录
- 可回溯原文

而不是继续用普通 lookup 的轻量 bundle 策略。

## P6-002.2 fallback

### P6-002.2.1 Vega 内部 fallback 停止条件

fallback 不是无限扩张。

至少应该在这些条件下停止：

- source fanout 已触顶
- token budget 已触顶
- 新 source 没带来显著增益
- 只剩低信号结果
- 当前 request 已进入 usage handoff 边界

### P6-002.2.2 Retrieval 到 Usage 的交接边界

retrieval 到这里就停止：

- 返回 bundle
- 返回 warnings
- 返回 `fallback_used`
- 返回 `next_retrieval_hint`

retrieval 不直接决定：

- 当前 turn 是否继续执行
- 是否已经 sufficient
- 是否要查外部世界

这些属于 `Phase 7 Usage Workflow`。

### P6-002.2.3 fallback 输出形态与 degraded semantics

当 retrieval 发生降级时，宿主看到的应是：

- `fallback_used = true`
- `warnings[]`
- `degraded` 语义字段（如有）
- 仍然合法的 bundle 结构

但不应该把 Vega 内部全部 debug 细节都直接暴露给宿主。

宿主看得到的是：

- 这次取有没有降级
- 降级大类是什么
- 下一步大致建议是什么

宿主看不到的是：

- 所有中间 ranker 分支
- 每个 source 的内部失败堆栈
- 内部 planner 的全部决策树

## P6-002.3 promotion → retrieval feedback

### P6-002.3.1 feedback 输入信号与来源

retrieval 侧可以消费的 feedback，优先是稳定信号：

- `promoted`
- `held`
- `discarded`
- `promotion_audit`
- visibility / retention 分类
- suppression / decay 信号

不应该直接把：

- usage.ack
- 宿主自由判断
- 临时实验性 score helper

混成同一个 feedback 面。

### P6-002.3.2 feedback 对 ranking / source selection / visibility 的生效边界

promotion feedback 可以影响：

- ranking 的 source prior
- 某些 source 的可见性
- query rewrite 的倾向
- retrieval source selection 的优先级

但不应该直接影响：

- 宿主下一步动作
- usage sufficiency 判定
- 外部工具调用

### P6-002.3.3 anti-loop guardrails

promotion feedback 必须防止形成自增强闭环。

至少要有：

- cooldown
- cap
- disable 开关
- 观测指标

否则 retrieval 会越来越只看自己曾经推过的东西。

## 不属于 P6-002 的内容

下面这些不在这份文档里：

- token budget 具体数值
- summary/snippet 深度策略
- usage sufficiency
- host-side execution

这些分别属于：

- `P6-003`
- `Phase 7`

## 一句话版本

`P6-002` 要做的，是把 Vega 内部“怎么取”这件事，从若干零散 retrieval primitive 收敛成一条统一 orchestration 主线。
