# Raw Archive and Audit Boundary

Status: accepted design spec  
Scope: raw_inbox、archive、audit 三层的权限/责任矩阵，以及被拒绝的操作和错误语义  
Non-goals: 定义 candidate/promoted 层的权限，或下游 wiki/fact/insight 的审计规则

## 1. Goal

明确 raw_inbox（收件箱）、archive（归档）、audit（审计）三层各自的权限边界、允许的操作、禁止的操作，以及操作被拒绝时的错误语义。

## 2. Permission / Responsibility Matrix

| 层 | 读权限 | 写权限 | 责任主体 | 数据性质 |
| --- | --- | --- | --- | --- |
| inbox | CRUD | CRUD | ingestion pipeline / runtime | 原始 envelope，临时存储 |
| archive | read + append | append-only | admin / automated retention job | 原始 envelope 的长期副本，不可变 |
| audit | append-only | append-only | system / admin | 操作日志，不可变 |

## 3. Inbox Layer（CRUD）

### 3.1 允许的操作

- **Create**：`insertRawInbox` — 幂等写入原始 envelope
- **Read**：`queryRawInbox` — 按 `event_id`、`source_kind`、`time range` 查询
- **Update**：更新 replay 元数据（`replay_count`、`last_replayed_at`）、标记 `archived`
- **Delete**：物理删除（由 retention job 在 > 90 天后执行）

### 3.2 禁止的操作

- 修改原始 `envelope` 内容（`content`、`source_kind`、`received_at` 等核心字段）
- 直接写入 `candidate` 或 `promoted` 层（必须通过 ingestion pipeline）

### 3.3 错误语义

| 操作 | 错误场景 | HTTP 状态码 | MCP 错误码 | 错误消息 |
| --- | --- | --- | --- | --- |
| Create | `event_id` 已存在（幂等） | `200 OK` | `ok` | 返回 `deduped: true`，无错误 |
| Create | `envelope` 格式非法 | `400 Bad Request` | `invalid_request` | `Invalid envelope: missing required field '{field}'` |
| Read | `event_id` 不存在 | `404 Not Found` | `not_found` | `Event '{event_id}' not found in raw_inbox` |
| Update | 尝试修改核心字段 | `403 Forbidden` | `forbidden` | `拒绝：inbox 层不允许修改 envelope 核心字段` |
| Delete | 手动删除（非 retention job） | `403 Forbidden` | `forbidden` | `拒绝：inbox 删除只能由 retention job 执行` |

## 4. Archive Layer（read + append）

### 4.1 允许的操作

- **Read**：`loadRawArchive` — 按 `project`、`time range`、`source_kind` 加载冷存数据回临时热区
- **Append**：`appendRawArchive` — 由 retention job 在温→冷转换时写入新分片

### 4.2 禁止的操作

- **修改（Update）**：archive 内容 immutable，不允许修改任何已写入的字段
- **删除（Delete）**：archive 对象的生命周期由外部存储（S3 / 文件系统）的策略管理，不允许通过 Vega API 删除
- **直接写入**：不允许绕过 inbox 层直接写入 archive（必须通过 retention job 的温→冷转换）

### 4.3 错误语义

| 操作 | 错误场景 | HTTP 状态码 | MCP 错误码 | 错误消息 |
| --- | --- | --- | --- | --- |
| Read | 请求的时间范围已超出冷存保留期 | `410 Gone` | `gone` | `Archive for '{project}/{time_range}' has expired` |
| Read | 分片文件损坏或校验失败 | `500 Internal Server Error` | `internal_error` | `Archive shard checksum mismatch` |
| Append | 非 retention job 调用 | `403 Forbidden` | `forbidden` | `拒绝：archive 追加只能由 retention job 执行` |
| Update | 任何修改请求 | `403 Forbidden` | `forbidden` | `拒绝：archive 内容不可变` |
| Delete | 任何删除请求 | `403 Forbidden` | `forbidden` | `拒绝：archive 删除由外部存储策略管理` |

## 5. Audit Layer（append-only）

### 5.1 允许的操作

- **Append**：`appendAuditLog` — 记录所有 inbox 和 archive 的操作日志
  - 包括：create、read、update、delete、replay、archive、load
  - 包括：成功和失败的操作
  - 包括：自动（retention job、replay job）和手动（admin）的操作

### 5.2 禁止的操作

- **Read**：audit log 的读取是允许的，但属于“只读”而非“CRUD 中的 R”
  - 读取权限仅限 admin 和审计系统
  - 普通 runtime 无权读取 audit log
- **Update**：不允许修改任何 audit log 记录
- **Delete**：不允许删除任何 audit log 记录

### 5.3 错误语义

| 操作 | 错误场景 | HTTP 状态码 | MCP 错误码 | 错误消息 |
| --- | --- | --- | --- | --- |
| Append | 写入成功 | `201 Created` | `ok` | 无错误 |
| Read | 普通 runtime 尝试读取 | `403 Forbidden` | `forbidden` | `拒绝：audit log 读取仅限 admin` |
| Update | 任何修改请求 | `403 Forbidden` | `forbidden` | `拒绝：audit log 不可变` |
| Delete | 任何删除请求 | `403 Forbidden` | `forbidden` | `拒绝：audit log 不可删除` |

## 6. Cross-Layer Operation Rules

### 6.1 允许的操作

| 操作 | 源层 | 目标层 | 说明 |
| --- | --- | --- | --- |
| 温→冷转换 | inbox | archive | retention job 自动执行 |
| 冷→临时热区加载 | archive | inbox（临时） | replay 或 admin 手动加载 |
| 操作记录 | inbox / archive | audit | 所有操作自动写入 audit log |

### 6.2 禁止的操作

| 操作 | 源层 | 目标层 | 拒绝原因 |
| --- | --- | --- | --- |
| 直接写入 archive | 外部 | archive | 必须经 inbox → retention job |
| 修改 archive | 任意 | archive | archive 内容不可变 |
| 删除 archive | 任意 | archive | 由外部存储策略管理 |
| 修改 audit log | 任意 | audit | audit log 不可变 |
| 删除 audit log | 任意 | audit | audit log 不可删除 |
| 绕过 inbox 直接写入 candidate | 外部 | candidate | 必须通过 ingestion pipeline |

## 7. Audit Log Schema（最小集）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `TEXT` | UUID |
| `timestamp` | `TEXT` | ISO-8601，操作发生时间 |
| `layer` | `TEXT` | `inbox` / `archive` / `audit` |
| `operation` | `TEXT` | `create` / `read` / `update` / `delete` / `replay` / `archive` / `load` |
| `actor` | `TEXT` | `system:retention_job` / `system:replay_job` / `admin:{user_id}` / `runtime:{service}` |
| `target_id` | `TEXT` | 被操作对象的 ID（如 `event_id`、archive shard path） |
| `status` | `TEXT` | `success` / `failure` |
| `error_code` | `TEXT` | 失败时的错误码（如 `forbidden`、`not_found`） |
| `details` | `TEXT` | JSON，可选的额外上下文 |

## 8. 与现有代码的关系

- `src/ingestion/raw-inbox.ts` 已实现 inbox 层的 CRUD 基础
- `src/ingestion/replay.ts` 已实现 replay 的 stub，尚未接入完整的 audit log
- `VM2-002` 已定义 `raw_archives` 表结构，但本 spec 的 archive 层更侧重于 raw_inbox 的冷存导出，而非 VM2-002 的通用 raw archive
- 后续实现将基于本 spec 的权限矩阵，在 API 层和 MCP 工具层添加统一的权限检查中间件
