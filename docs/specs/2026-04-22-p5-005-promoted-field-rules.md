# P5-005 Promoted Field Rules

## 这份文档是干什么的

这份文档只回答一件事：

当前代码基线下，promoted 进入正式 memory 之后，  
哪些字段是稳定字段，哪些 promotion 信息不该硬塞进主表，visibility / retention 这两件事现在该怎么收口。

## 先说现状

当前 promoted 不是独立表。  
它现在就是正式 `memories` 里的 memory 行。

所以现在真正要做的，不是重新造一张 promoted 表，  
而是把：

- 现在已经在 `memories` 里的字段
- promotion 需要但不该放进主表的信息

分清楚。

## 当前 promoted 已经稳定依赖的字段

按现有代码，promoted 现在实际依赖的是通用 memory 字段：

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

这意味着一件事：

**Phase 5 现在不用再重新定义一套独立 promoted 主字段。**

先把这套通用 memory 字段当成 promoted 的正式落点就够了。

## 哪些 promotion 信息不要硬塞进 memory 主表

下面这些东西更适合放在别的地方：

### 1. promotion 审计

例如：

- 为什么晋升
- 哪条规则触发
- 谁触发的
- 从什么状态到什么状态

这些应该放在 `promotion_audit`。

### 2. candidate 侧过程信息

例如：

- extraction_source
- extraction_confidence
- candidate_state
- visibility_gated
- promotion_score

这些本来就是 candidate 层信息，  
不要为了“看起来完整”就抄进 promoted 主表。

### 3. 将来可能扩展的判断细节

例如：

- rule breakdown
- scoring explanation
- 临时实验阈值

这些也不应该急着写死进 `memories`。

## visibility 现在该怎么定

Phase 5 这里先收规则，不收运行时实现。

也就是说：

- 先把 visibility 的业务意思写清楚
- 不要假装当前 runtime filtering 已经完整闭环

目前更合理的做法是：

- visibility 作为 promoted 的业务规则存在
- 真正 retrieval 侧的过滤实现留到 Phase 6

## retention 现在该怎么定

retention 也是先收规则，不急着写成完整清理系统。

Phase 5 这里先定这两件事：

1. promoted 是长期保留层，不是临时缓存
2. retention 规则要能表达不同处理方式

例如可以先收成几类：

- time-based
- usage-based
- manual

但先不要假装 cleanup job 和策略执行器都已经在这批里完成了。

## 当前 promoted 和 retrieval 的关系

现在 `promoted-memory` source 已经说明：

- promoted 已经进入 retrieval 输入面

但这不代表：

- promoted retrieval API 已经要在 Phase 5 里实现
- visibility runtime filtering 已经完整闭环

这两件事还是要继续分开看。

## 这份文档真正要定下来的话

一句话说完就是：

- promoted 现在落在通用 `memories`
- 主字段先复用 memory 现有字段
- promotion 过程信息留在 audit 或 candidate 侧
- visibility / retention 先定规则，不提前写 retrieval 运行时

## 不属于 P5-005 的内容

下面这些不在这份文档里：

- promoted retrieval API
- visibility runtime filtering
- ranking feedback
- usage.ack

这些分别属于：

- Phase 6
- Phase 7

## 一句话版本

`P5-005` 现在要做的，不是多造一张表，而是把 promoted 在现有 memory store 里的字段边界收干净。
