# P6-001 Host-side Retrieval Workflow v1

## 这份文档是干什么的

这份文档只回答一件事：

宿主在 Phase 6 里，应该如何发起一次 retrieval 请求，以及拿回来的 `context bundle` 最小应该长什么样。

重点不是让宿主重新变重，  
而是把宿主和 Vega 在“取”这一步的边界收清楚。

## 核心原则

### 1. Host stays thin, Vega owns retrieval intelligence

宿主负责：

- 判断现在是不是该取
- 说明这次 retrieval 的 intent
- 提供最小必要上下文
- 消费返回的 bundle

Vega 负责：

- retrieval planning
- source selection
- query rewrite
- ranking
- token 控制
- fallback
- bundle 组装

一句话：

**宿主负责发起，Vega 负责怎么取。**

### 2. 宿主表达 intent，不直接选 retrieval primitive

宿主不再直接决定：

- `session_start`
- `recall`
- `wiki_search`
- `deep_recall`

宿主只表达：

- 现在要不要取
- 为什么取
- 这次 retrieval 关注什么

## 请求契约

### retrieval intent

Phase 6 先固定 4 个 intent：

| intent | 用途 | 宿主语义 |
| --- | --- | --- |
| `bootstrap` | 会话起点预热 | 给我一份高密度起始上下文 |
| `lookup` | 定向查找 | 围绕一个问题/对象精准取回 |
| `followup` | 补取 | 上一轮 bundle 不够，继续补一层 |
| `evidence` | 证据/原文 | 需要 provenance、更原始、更可追溯的材料 |

### 请求字段

Host-side Retrieval Workflow v1 的最小请求面建议统一成：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `intent` | string | 必填，取值见上表 |
| `query` | string \| null | 查询文本；`bootstrap` 可为空 |
| `mode` | string | 可选，默认 `L1` |
| `surface` | string | 宿主来源，如 `claude` / `codex` |
| `session_id` | string | 必填 |
| `thread_id` | string \| null | 可空 |
| `project` | string \| null | 可空 |
| `cwd` | string \| null | 可空 |
| `prev_checkpoint_id` | string \| null | `followup` 时使用 |
| `query_focus` | string \| null | 宿主想强调的关注面 |
| `host_hint` | object \| null | 宿主的弱提示，不是强制路由命令 |

## P6-001.1 retrieval request 边界

### P6-001.1.1 retrieve_mode / mode 语义边界

当前 retrieval 请求的 canonical 字段记为 `mode`。

建议保留 4 个 level：

| mode | 含义 |
| --- | --- |
| `L0` | 极轻量，只拿最关键上下文 |
| `L1` | 默认日常 retrieval |
| `L2` | 扩展 retrieval，允许更多 source 与更深摘要 |
| `L3` | 证据模式，优先 provenance 与原文 |

`mode` 只是 budget / depth dial，  
不是宿主自己选工具的入口。

### P6-001.1.2 nullable 字段规则

这些字段允许为 `null`：

- `thread_id`
- `project`
- `cwd`
- `query`
- `prev_checkpoint_id`
- `query_focus`
- `host_hint`

原则是：

- 宿主不知道就传 `null`
- 不为了凑字段编假值
- Vega 自己处理缺省上下文

### P6-001.1.3 query_focus 与 host_hint 边界

`query_focus` 是宿主对“这次 retrieval 更偏向哪一面”的弱约束，例如：

- `history`
- `docs`
- `mixed`
- `evidence`

`host_hint` 是宿主给 Vega 的辅助上下文，例如：

- 最近操作的文件
- 用户显式点名的 topic
- 疑似相关 source
- 时间窗口

但两者都**不能**变成：

- 宿主直接指定 source
- 宿主直接指定 ranker 策略
- 宿主绕过 Vega 的 retrieval orchestration

## P6-001.2 context bundle contract

### P6-001.2.1 最小字段集

返回给宿主的 bundle 最小应该至少包含：

| 字段 | 说明 |
| --- | --- |
| `checkpoint_id` | 本次 retrieval 的 checkpoint |
| `bundle_digest` | 当前 bundle 内容摘要哈希 |
| `sections[]` | bundle 主体 |
| `used_sources[]` | 实际命中的 source |
| `fallback_used` | 是否触发了 fallback |
| `confidence` | Vega 对这次 bundle 的整体信心 |
| `warnings[]` | 降级/缺口提示 |
| `next_retrieval_hint` | 下一步 retrieval advisory |

### sections / records 结构

每个 section 至少包含：

- `kind`
- `title`
- `records[]`

每条 record 至少包含：

- `record_id`
- `source_kind`
- `content` 或 `snippet`
- `provenance`
- `score`（可选）

### P6-001.2.2 used_sources / fallback_used / confidence 边界

`used_sources`
- 只记录本次**实际参与输出**的 source

`fallback_used`
- 只表达“有没有走 fallback”，不表达内部所有分支细节

`confidence`
- 是整体 bundle 信号，不是每条 record 的替代分数

宿主可以消费这些字段，  
但不能把它们当作新的 routing engine。

### P6-001.2.3 next_retrieval_hint 的 advisory 规则

`next_retrieval_hint` 只是 advisory，不是命令。

建议只表达下一步 retrieval 方向，例如：

- `none`
- `followup`
- `evidence`
- `broaden_query`
- `narrow_query`
- `needs_external`

宿主可以参考它，  
但最终是否继续 retrieval，仍由宿主按 workflow 决定。

## 宿主负责什么，不负责什么

### 宿主负责

- 发请求
- 传最小上下文
- 拿回 bundle
- 把 bundle 纳入当前 turn

### 宿主不负责

- source selection
- query rewrite
- ranker
- token slicing
- fallback 细节策略

## 不属于 P6-001 的内容

下面这些不在这份文档里：

- Vega 内部 orchestration 细节
- ranking 规则
- token budget 细则
- observability 指标
- usage 层 checkpoint / sufficiency

这些分别属于：

- `P6-002`
- `P6-003`
- `P6-004`
- `Phase 7`

## 一句话版本

`P6-001` 要做的，是把宿主“怎么发起 retrieval、返回体长什么样、哪些字段只是 advisory”收成一套稳定 contract。
