# P5-001 Host Event Envelope v1

## 这份文档是干什么的

这份文档只回答一件事：

宿主在“存”这一步，到底该把什么东西交给 Vega，以及 Vega 收到之后各自负责什么。

目标不是重新设计整个系统，而是把已经做出来的代码和你现在确认下来的原则，收敛成一份清楚、不打架的规则。

## 核心原则

### 1. Host thin, Vega thick

宿主只负责：

- 采集事件
- 结构化事件
- 做最小的安全处理
- 生成一个格式正确的 envelope
- 把 envelope 可靠交给 Vega

Vega 负责：

- canonical normalization
- sanitation / degradation
- raw inbox 写入
- candidate 提取
- dedup
- promotion
- 后续 wiki / fact / insight 派生

简单说：

- 宿主负责“把东西送进来”
- Vega 负责“把它变成 memory intelligence”

### 2. 宿主只做 transport-level 校验

宿主可以校验：

- 必填字段是否存在
- `event_id` 是否像 UUID
- `timestamp` 是否像 ISO 8601 UTC
- `payload` 是否是合法 JSON

宿主不负责校验：

- `surface` 是否一定是 canonical value
- `event_type` 是否一定在推荐列表里
- 这条事件有没有长期价值
- 这条事件该不该晋升

### 3. canonical normalization 在 Vega 侧

`surface`、`role`、`event_type` 的推荐值可以写给宿主参考，但真正的：

- 归一化
- unknown fallback
- warning 记录

都在 Vega ingestion 侧做。

不要把这一层逻辑塞回宿主 SDK。

## 宿主交给 Vega 的 envelope

### 基础字段

宿主侧 transport contract 至少包含：

- `schema_version`
- `event_id`
- `surface`
- `session_id`
- `thread_id`
- `project`
- `cwd`
- `timestamp`
- `role`
- `event_type`

其中：

- `thread_id` 可以为 `null`
- `project` 可以为 `null`
- `cwd` 可以为 `null`

原因很简单：宿主不一定知道这些值，不能为了凑字段硬编。

### 复合字段

还应包含：

- `payload`
- `safety`
- `artifacts`

约束如下：

#### `payload`

- 任意 JSON 对象
- 宿主只负责把原始事件结构化放进去

#### `safety`

- 表示宿主有没有做过最小安全处理
- 至少保留：
  - `redaction_applied`
  - `truncated`

#### `artifacts`

- 必须是数组
- 不使用单值 `artifact_ref`
- 每项表达一个产物引用

## 推荐值与强制值

### 推荐值

宿主可以参考推荐值，例如：

- `surface`: `claude / codex / cursor / opencode / hermes / api / cli`
- `role`: `user / assistant / system / tool`

这些推荐值的作用是：

- 减少 Vega 侧归一化成本
- 提高跨宿主一致性

### 不强制

但在 Phase 5 的原则下，宿主**不因为值域不规范而拦住投递**。

只要 transport-level 格式是对的，就应该允许事件进入 Vega。

值域统一是 Vega 的事情。

## Vega 收到 envelope 后做什么

Vega 在 ingestion 里继续做：

1. 基础 sanitation
   - 例如 `artifacts` 不是数组时降级为空数组
   - `thread_id/project/cwd` 为 `null` 时正常放行

2. canonical normalization
   - `surface`
   - `role`
   - `event_type`

3. warning 记录
   - 保留原始值
   - 记录降级后的值

4. raw inbox 写入

注意：

这里不需要单独再发明一个新的“normalized envelope”产品层对象。

对外还是 `Host Event Envelope v1`。
Vega 内部在 ingestion 流水线里做宽容处理和归一化即可。

## 不属于 P5-001 的内容

下面这些都不在这份文档里定义：

- retrieval API
- usage.ack
- promotion 规则
- value judgment
- retrieval visibility filter
- execution fallback

这些分别属于：

- Phase 6
- Phase 7
- 或 Phase 5 后续的 candidate/promoted 主链

## 和现有代码的关系

当前仓库里已经有一份可运行基线：

- `/Users/johnmacmini/workspace/vega-memory/src/core/contracts/envelope.ts`
- `/Users/johnmacmini/workspace/vega-memory/src/core/contracts/enums.ts`

这份文档不是要推翻它们，而是要把它们解释清楚，并把边界拉直：

- 哪些是宿主 contract
- 哪些是 Vega ingestion 语义
- 哪些以后不能再混写

## JSON Schema 工件

独立的 JSON Schema 文件已落地：

- `docs/specs/host-event-envelope-v1.schema.json`

该文件与 `HOST_EVENT_ENVELOPE_TRANSPORT_V1` 的 Zod 定义保持对齐，覆盖 transport-level 的必填字段、类型约束和 `source_kind` 枚举值。

## 子文档索引

- [delivery-reliability.md](./delivery-reliability.md) — 宿主投递可靠性基线（去重、重试、离线缓存、顺序保证）
- [schema-versioning.md](./schema-versioning.md) — schema_version 演进与兼容策略（版本号规则、向前兼容、废弃流程）

## 一句话版本

宿主负责把事件可靠送进来，Vega 负责把事件变成 memory intelligence。

