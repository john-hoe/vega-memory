# P5-002 Vega Layered Ingestion v1

## 这份文档是干什么的

这份文档只回答一件事：

Vega 在“存”这条主线上，收到宿主事件之后，内部应该怎么分层、怎么流转、怎么写入。

重点不是重新发明新系统，而是把当前已经存在的：

- raw inbox
- candidate
- promoted

这三层收成一套清楚、能长期维护的规则。

## 只保留 3 层

Phase 5 先只保留这 3 层：

1. `raw_inbox`
2. `candidate`
3. `promoted`

先不要把：

- wiki
- fact
- insight

写成独立 layer。

它们先视为：

**从 promoted 往后继续派生的 downstream 结果。**

## 每一层负责什么

### 1. raw_inbox

这一层只负责：

- 接住宿主原始 envelope
- 保存原始事件
- 提供幂等写入
- 提供 replay / retention 的基础面

它不是：

- 价值判断层
- 晋升层
- 最终检索层

简单说：

**raw_inbox 是“收件箱”，不是“记忆库”。**

### 2. candidate

这一层负责：

- 从 raw event 提取出候选内容
- 记录提取结果
- 记录去重相关信息
- 进入后续价值判断前的中间状态

它的目标是：

把“原始事件”变成“值得进一步判断的候选内容”。

### 3. promoted

这一层负责：

- 保存已经确认有价值的内容
- 作为后续 retrieval 的稳定输入面
- 作为 wiki / fact / insight 的上游来源

promoted 才是真正接近长期 memory 的层。

## 这一层次里谁做智能判断

还是同一条原则：

- 宿主不做复杂判断
- **Vega 做**

具体到分层摄取：

- 宿主负责把 envelope 送进来
- Vega 负责：
  - sanitation
  - canonical normalization
  - raw_inbox 写入
  - candidate 提取
  - dedup
  - value judgment
  - promotion

## raw_inbox 的边界

### raw_inbox 保存什么

raw_inbox 保存的是：

- 原始 envelope
- 服务端接收时间
- 最小写入元数据

### raw_inbox 不保存什么

raw_inbox 不应该提前保存一堆 Vega 内部归一化结果，比如：

- `normalized_surface`
- `normalized_role`
- `normalized_event_type`

这些可以在 ingestion pipeline 里作为**内部瞬时步骤**存在，  
但不应该把 raw_inbox 变成“半加工层”。

## candidate 的边界

candidate 层至少要解决两件事：

1. **提取**
   - 从不同 `event_type` 里抽出真正值得判断的内容

2. **去重**
   - 精确去重
   - 模糊去重

所以 candidate 层要把这两个概念分开：

- `raw_dedup_key`
  - 确定性的 hash
  - 用来抓完全重复

- `semantic_fingerprint`
  - 相似内容签名
  - 用来抓改写后但本质重复的内容

不要再把这两个概念混成一个字段。

## promoted 的边界

promoted 层现在先做两件事：

1. 定义长期保存的 memory 结构
2. 定义 visibility / retention 规则

但注意：

**retrieval 过滤代码本身不在 Phase 5 实现。**

Phase 5 只需要把：

- promoted 的字段
- visibility 的业务规则
- retention 的分类方式

写清楚。

真正的 retrieval API 和 runtime filtering 放到 Phase 6。

## ingestion pipeline 应该长什么样

可以收成下面这条主线：

1. 宿主提交 envelope
2. Vega 做最小 sanitation
3. Vega 做 canonical normalization
4. 幂等写入 raw_inbox
5. 提取 candidate
6. 做 dedup
7. 做 value judgment
8. 满足条件则 promotion 到 promoted

这条线里最重要的边界是：

- sanitation / normalization 在 Vega 内部完成
- raw_inbox 保存原始事件
- candidate 是中间判断层
- promoted 是长期保留层

## 和现有代码的关系

当前仓库里已经有可用基线：

- `/Users/johnmacmini/workspace/vega-memory/src/ingestion/raw-inbox.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/ingestion/ingest-event-handler.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/db/candidate-repository.ts`

所以这份文档的目标不是“从 0 开始定义一个系统”，  
而是：

**把已经存在的实现收敛成一套 Phase 5 说得清楚的分层规则。**

## 不属于 P5-002 的内容

下面这些不放在这份文档里：

- promoted retrieval API
- usage.ack
- external fallback
- usage 状态机

这些分别属于：

- Phase 6
- Phase 7

## 子文档索引

以下子文档对 P5-002 的特定主题进行了细化定义：

| 子文档 | 覆盖主题 | 状态 |
| --- | --- | --- |
| [raw-inbox-retention.md](./raw-inbox-retention.md) | raw_inbox 四层保留策略（热/温/冷/删除） | accepted |
| [raw-replay.md](./raw-replay.md) | raw_inbox replay 触发场景、隔离与进度跟踪 | accepted |
| [raw-archive-audit.md](./raw-archive-audit.md) | raw_inbox / archive / audit 权限矩阵与错误语义 | accepted |

## 一句话版本

`P5-002` 要做的不是“多建几张表”，而是把 Vega 的“收件箱 → 候选层 → 长期层”这条路收成一套干净、稳定、可维护的规则。

