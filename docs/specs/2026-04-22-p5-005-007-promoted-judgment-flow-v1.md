# P5-005 / P5-006 / P5-007 Promoted / Value Judgment / Promotion Flow v1

## 这份文档是干什么的

这份文档只回答一件事：

在 `candidate -> promoted` 这半段主线上，  
现在的 promoted 到底是什么，value judgment 现在做到哪了，promotion flow 现在怎么跑，后面真正还要补什么。

重点不是凭空发明一套新系统，  
而是把当前已经存在的 promotion 代码，收成一套说得清楚的规则。

## 先说现在已经有什么

当前仓库里已经有这些基线：

- `Repository.createFromCandidate()`
- `Repository.demoteToCandidate()`
- `promotion policy`
- `promotion evaluator`
- `promotion orchestrator`
- `promotion audit`
- `promoted memory source`

这意味着：

- promoted 已经不是“未来概念”
- value judgment 也不是“完全没做”
- promotion flow 已经能跑 manual / policy / sweep 这些路径

所以 `P5-005 / 006 / 007` 现在真正要做的，  
不是“从零实现 promotion”，  
而是把：

- 现在已经在跑的基线
- 和 Phase 5 想要的边界

对齐清楚。

## promoted 现在到底是什么

当前代码里，promoted 不是一张单独的新表。  
它本质上还是 `memories` 里的正式 memory 行。

也就是说，当前 promoted 的真实落点是：

- candidate 经过判断
- 通过 `createFromCandidate()`
- 进入通用 `memories` 表
- 再通过 `promoted-memory` source 进入 retrieval 输入面

所以现在最重要的口径是：

**promoted 目前是“进入正式 memory store 的候选内容”，不是一套独立数据库子系统。**

## 这件事带来的直接结论

### 1. 先不要假装现在已经有独立 promoted 表

如果后面真的要把 promoted 从 `memories` 里拆出来，  
那是后续结构调整。

但以当前代码基线来说，  
Phase 5 应该先承认现状：

- promoted 现在就是正式 memory
- 共享 memory 的通用字段
- promotion 元数据主要散在：
  - candidate 层
  - audit 层
  - source_context

### 2. promoted schema 现在更像“字段口径收敛”

现在需要收的是：

- promoted 作为正式 memory，哪些字段必须稳定
- 哪些是通用 memory 字段
- 哪些 promotion 相关信息不应该硬塞进 memory 主表

## promoted 至少要稳定下来的字段

按现在代码基线，promoted 至少已经有这些方向：

- `id`
- `type`
- `project`
- `title`
- `content`
- `summary`
- `importance`
- `source`
- `tags`
- `status`
- `verified`
- `scope`
- `accessed_projects`
- `source_context`
- `source_kind`
- `created_at`
- `updated_at`
- `accessed_at`
- `access_count`

这里要特别说明两点：

### access 相关字段已经在通用 memory 里

所以 Phase 5 这里不需要再单独重新定义：

- `last_accessed_at`
- `access_count`

它们现在已经是通用 memory 的一部分。

### visibility 不是当前代码里已经独立落好的 runtime 机制

现在更合理的口径是：

- Phase 5 先把 visibility 规则说清楚
- 先不要假装当前 promoted runtime filtering 已经完整存在

也就是说，当前 promoted “能被 retrieval 看见”，  
不等于“visibility 规则已经完整闭环”。

## value judgment 现在到底是什么

当前 value judgment 已经有一版可运行基线，  
但它不是一套完整、最终定稿的规则系统。

今天的主线是：

- `policy.ts`
- `evaluator.ts`
- `orchestrator.ts`

当前已经支持的信号主要有：

- manual trigger
- policy trigger
- sweep trigger
- age rule
- sufficient ack rule

另外仓库里还有：

- `calculatePromotionScore.ts`

但这个文件现在更像一个局部 helper，  
不能直接当成“整个 value judgment 已经定稿”的证据。

## 所以 P5-006 真正要做什么

不是“从零做一个打分器”。  
而是把现在已经存在的判断方式收成更清楚的规则：

### 1. 说清哪些信号是正式信号

例如：

- age
- ack
- manual
- 后续可扩展 scoring

### 2. 说清哪些信号只是辅助

例如：

- 局部 score helper
- 临时实验性阈值

### 3. 让结果能解释

不要只停留在：

- promote
- hold
- discard

还要能说清：

- 为什么是这个结果
- 是哪条规则触发的

## promotion flow 现在是怎么跑的

当前 promotion flow 已经有一条真实主线：

1. 读取 candidate
2. evaluator 调 policy
3. 得到 decision
4. orchestrator 根据 decision 执行动作
5. 写 audit

如果 decision 是 promote：

- `createFromCandidate()`
- 删除 candidate
- 写 promotion audit

如果 decision 是 hold / discard：

- 更新 candidate_state
- 写 promotion audit

如果是 manual demote：

- 用同一个 id 把 promoted memory 投回 candidate
- candidate 回到 `held`
- 同时删除 memory 行
- 写 promotion audit

## promotion flow 里现在最值得保留的规则

### 1. candidate 和 promoted 可以复用同一个 id

这点现在已经存在，  
而且是一个很关键的边界。

它的价值是：

- lineage 清楚
- audit 容易串起来
- demote 时不会生成第二套身份

### 2. promotion 审计已经是正式组成部分

promotion audit 现在不是附属品，  
而是主链的一部分。

因为只要有：

- promote
- hold
- discard
- demote

这些动作，就必须有能回看的记录。

### 3. current promoted retrieval input 已经存在

`promoted-memory.ts` 已经说明：

- promoted 现在已经进入 retrieval 输入面

但这不代表：

- promoted retrieval API
- ranking 反馈回路
- visibility runtime filtering

这些后续部分已经完成。

## 这一组现在真正还缺什么

### 1. promoted 业务字段边界还需要写死

现在代码里用的是通用 memory 模型。  
Phase 5 需要补的是：

- promoted 依赖哪些通用字段
- promotion 元数据应该留在哪
- 哪些东西不要塞回 memory 主表

### 2. value judgment 还需要统一口径

现在已经有：

- 规则判断
- 局部 scoring helper

但它们还没有完全收成一套统一说法。

### 3. visibility / retention 还是规则先行

Phase 5 这里先把：

- visibility 的业务规则
- retention 的分类

写清楚。

runtime filtering 和 retrieval 层接法，还是留在 Phase 6。

## 不属于这一组的内容

下面这些不放在这份文档里：

- promoted retrieval API
- retrieval ranking feedback
- usage.ack feedback loop
- usage 状态机

这些分别属于：

- Phase 6
- Phase 7

## 和现有代码的关系

这份文档是基于下面这些文件写的：

- `/Users/johnmacmini/workspace/vega-memory/src/db/repository.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/core/types.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/promotion/policy.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/promotion/evaluator.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/promotion/orchestrator.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/promotion/audit-store.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/promotion/calculatePromotionScore.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/retrieval/sources/promoted-memory.ts`

所以它的目标不是推翻当前实现，  
而是把现在已经做出来的 promotion 半条链路，收成一套更干净的规则。

## 一句话版本

`P5-005 / 006 / 007` 现在要做的，不是再造一条 promotion 系统，  
而是把当前已经存在的 promoted 落点、value judgment 基线、promotion flow 主线，收成一套清楚、稳定、能继续往下拆的规则。
