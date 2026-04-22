# P5-003 Candidate / Promotion v1

## 这份文档是干什么的

这份文档只回答一件事：

在 `raw_inbox -> candidate -> promoted` 这条主线上，  
candidate 怎么来，怎么去重，怎么判断值不值得留下，最后怎么进入 promoted。

重点不是重做一遍现有代码，  
而是把现在已经有的：

- candidate 中间层
- promotion policy / evaluator / orchestrator
- promoted memory source

收成一套清楚的规则。

## 先说现状

当前代码已经不是一片空白。

仓库里已经有这些基线：

- `candidate_memories` 表和仓储
- candidate 检索适配器
- promotion policy / evaluator / orchestrator
- promotion audit
- promoted memory source

所以 `P5-003` 现在要做的，不是“从零发明 candidate 和 promotion”，  
而是把：

- 现在已经跑起来的部分
- 和 Phase 5 真正想要的边界

对齐清楚。

## 这一层的核心问题

这部分真正要解决的是 4 个问题：

1. **什么东西算 candidate**
2. **哪些 candidate 是重复的**
3. **哪些 candidate 值得晋升**
4. **晋升后在 Vega 里以什么形态存在**

## candidate 是什么

candidate 不是长期 memory。  
candidate 是：

- 从原始事件里提取出来的候选内容
- 已经比 raw event 更适合判断
- 但还没有被正式确认有长期价值

所以 candidate 的定位就是：

**“待判断层”**

## candidate 这一层现在已经有什么

当前代码里的 candidate 基线，已经有这些东西：

- 内容本体
- 类型
- project
- tags / metadata
- 提取来源
- 提取置信度
- `promotion_score`
- `visibility_gated`
- `candidate_state`

现在已经落地的 `candidate_state` 是：

- `pending`
- `held`
- `ready`
- `discarded`

也就是说，当前代码里还**没有**把：

- `duplicate`
- `promoted`

当成 candidate 表里的常驻状态。

这点后面写 spec 和 brief 时要统一口径，不能文档一套、代码一套。

## candidate 这一层至少还要补什么

### 1. 提取

要能从不同事件里抽出可判断内容。

例如：

- message
- tool result
- decision
- file change

不是所有原始 payload 都适合直接拿去做价值判断。  
先提取，再判断。

### 2. 状态

Phase 5 这里要做的，不是推翻当前 `pending / held / ready / discarded`，  
而是把它们的意思写清楚：

- `pending`
  - 刚进入 candidate 层，后续还要继续处理
- `held`
  - 暂时保留，不晋升，也不丢掉
- `ready`
  - 已经通过当前判断，可以进入下一步 promotion
- `discarded`
  - 当前这条路结束，不再继续推进

## 去重这块现在的真实情况

当前代码里还没有把去重正式收成两个稳定字段。  
所以这里要明确分开的是 **Phase 5 目标口径**，不是假装代码里已经有：

- `raw_dedup_key`
  - 用来抓完全重复
- `semantic_fingerprint`
  - 用来抓改写后的近重复

最重要的是，这两个概念不要再混成一句模糊的“dedup key”。

## value judgment 是什么

value judgment 不是宿主的责任。  
这是 Vega 的责任。

但要看清楚：  
**当前代码里已经有一版 promotion 判断基线了。**

今天的基线主要在：

- `policy.ts`
- `evaluator.ts`
- `orchestrator.ts`

它现在已经支持：

- manual trigger
- policy trigger
- sweep trigger
- 基于 age 的判断
- 基于 sufficient ack 的判断
- promotion / hold / discard / demote 这些动作

所以 `P5-003` 不需要假装“value judgment 还完全不存在”。  
更准确的说法是：

- 现在已经有一版可运行的判断逻辑
- 但 Phase 5 要把它收成更清楚的规则边界
- 让“什么是值、为什么晋升、哪些信号参与判断”说得更清楚

## value judgment 至少要收成什么样

### 1. 能判断

不管最后是打分、阈值、规则组合，  
都要明确 candidate 为什么会：

- 被保留
- 被晋升
- 被丢弃

### 2. 能解释

不要只给一个最终结果。  
至少要能说清：

- 是 age 触发了
- 还是 ack 触发了
- 还是人工触发了
- 还是后面会补的 scoring 规则触发了

### 3. 能继续收敛

当前仓库里已经有：

- `calculatePromotionScore.ts`

但这类 helper 现在还只是一个局部基线，  
不能直接当成“Phase 5 已经把 value judgment 完整定稿了”。

所以这里要收的，是**判断边界和解释方式**，  
不是急着把某个具体分数函数写死成最终答案。

## promotion 是什么

promotion 不是去重，  
也不是 retrieval。

promotion 只做一件事：

**把已经判断为“值得长期保留”的 candidate，正式变成 promoted memory。**

所以这一步应该只负责：

1. 读取 candidate
2. 根据 value judgment 结果判断
3. 通过则晋升
4. 不通过则保持不动或丢弃
5. 写审计记录

当前代码已经有这部分基线：

- `promotion-orchestrator.ts`
- `promotion-audit-store.ts`

也可以直接记成一句话：

- 当前 promotion 已经有 `policy / evaluator / orchestrator / audit` 这四块基线

这说明 Phase 5 这里要做的是：

- 把 promotion 该负责的边界说清楚
- 把 audit 为什么存在、记录什么说清楚

而不是再发明第二套 promotion 主线。

## promoted 是什么

promoted 是长期 memory 输入面。

它和 candidate 的区别是：

- candidate：待判断
- promoted：已确认值得长期保留

promoted 层现在先要解决两件事：

1. 怎么存
2. 谁能看到

但注意：

**retrieval API 不是 Phase 5 的任务。**

Phase 5 只定义：

- promoted 的字段
- visibility 的规则
- retention 的分类

真正把它接成 retrieval 接口，是 Phase 6。

## promoted 至少要有的字段方向

promoted 至少应该能表达：

- 来自哪个 candidate
- 内容本体
- 可选 embedding / vector
- visibility
- retention_policy
- created_at
- last_accessed_at
- access_count

如果 visibility 规则里需要：

- `project`
- `owner_id`

那 schema 里就要真的有这些字段。  
不要文档里说有，表里却没有。

## 这一块和现有代码的关系

当前仓库里已经有明显基线：

- `/Users/johnmacmini/workspace/vega-memory/src/db/candidate-repository.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/promotion/policy.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/promotion/evaluator.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/promotion/orchestrator.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/promotion/audit-store.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/promotion/calculatePromotionScore.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/retrieval/sources/promoted-memory.ts`

所以这份文档不应该再写成：

- “从零设计一个 promotion 系统”

而应该写成：

- “把当前 candidate / promotion / promoted 的基线收成一套稳定规则”

## 现状里已经做完的，和还没收清的

### 已经做完的基线

- candidate 表和仓储已经有了
- candidate source 已经有了
- promotion 的 policy / evaluator / orchestrator 已经有了
- promotion audit 已经有了
- promoted memory source 已经已经进了 retrieval 输入面

### 还没收清的地方

- candidate 状态的最终口径还需要文档化
- 精确去重 / 模糊去重还没有稳定字段口径
- value judgment 需要更清楚的“解释层”
- promoted 的 visibility / retention 规则还需要单独定稿

## 下游派生边界

P5-003 只负责 candidate → promoted 的晋升判断。

promoted memory 进入 wiki / fact / insight 派生管线的输入边界，在以下文档中定义：

- [`derived-pipeline.md`](./derived-pipeline.md) — wiki / fact / insight 的输入条件、质量阈值、类型限制

这份边界文档属于 Phase 5 规划范围，但派生管线的完整运行时、人工审核流、失败处理不属于 Phase 5。

## 不属于 P5-003 的内容

下面这些不放在这份文档里：

- promoted retrieval API
- usage.ack feedback loop
- retrieval ranking 反馈回路
- usage 状态机
- 派生管线的运行时实现

这些属于：

- Phase 6
- Phase 7

## 一句话版本

`P5-003` 要做的，是把 Vega 从“收到了候选内容”推进到“确认哪些值得留下”，并把这条判断链路收成一套清楚、稳定、可维护的规则。
