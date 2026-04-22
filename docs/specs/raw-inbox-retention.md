# Raw Inbox Retention Strategy

Status: accepted design spec  
Scope: raw_inbox lifecycle, TTL tiers, storage backend mapping  
Non-goals: define candidate/promoted retention, or downstream wiki/fact/insight eviction

## 1. Goal

Define how long raw_inbox events stay in each temperature tier before deletion, and what read/write behavior is allowed at each tier.

## 2. Retention Tiers

| 分层 | TTL | 存储后端 | 读行为 | 写行为 |
| --- | --- | --- | --- | --- |
| 热 | 7 天 | SQLite `raw_inbox` 表 | 全字段随机读 + 索引过滤 | 幂等写入、追加写入 |
| 温 | 30 天 | SQLite `raw_inbox` 表 + 压缩分区 | 全字段随机读（自动解压） | 只读，禁止新写入 |
| 冷 | 90 天 | 外部冷存（文件系统 / S3 兼容对象存储） | 顺序扫描，需显式加载回本地 | 只读，禁止修改 |
| 删除 | > 90 天 | 已物理删除 | 不可读 | 不可写 |

## 3. Tier Semantics

### 3.1 热（Hot）

- 时间窗口：事件写入后 0–7 天
- 存储位置：主 SQLite `raw_inbox` 表，未压缩
- 读行为：支持 `event_id` 精确查找、`source_kind` 过滤、时间范围扫描
- 写行为：
  - 允许幂等写入（`INSERT OR IGNORE`）
  - 允许追加元数据（如 `replay_count`、`last_replayed_at`）
  - 不允许修改原始 `envelope` 内容

### 3.2 温（Warm）

- 时间窗口：7–30 天
- 存储位置：仍在 `raw_inbox` 表，但 SQLite `PRAGMA auto_vacuum` 或显式 `VACUUM` 可压缩旧页
- 读行为：与热层相同，查询性能可能因页压缩轻微下降
- 写行为：
  - **禁止新事件写入**
  - 允许更新 replay 元数据（`replay_count`、`last_replayed_at`）
  - 允许标记 `archived = true`

### 3.3 冷（Cold）

- 时间窗口：30–90 天
- 存储位置：从 SQLite 导出到外部冷存（本地文件系统或 S3 兼容对象存储），按 `project/YYYY-MM/raw_inbox-{shard}.ndjson.zst` 分片
- 读行为：
  - 不支持随机索引查找
  - 需通过 `raw_archive` 接口显式加载回本地临时表或流式扫描
  - 加载后进入“临时热区”，7 天后自动清理
- 写行为：
  - **只读**
  - 不允许修改、追加、删除

### 3.4 删除（Deleted）

- 时间窗口：> 90 天
- 存储位置：物理删除
- 读行为：不可读；`queryRawInbox` 返回空结果
- 写行为：不可写
- 例外：若事件已被 `promoted` 到长期记忆层，其原始 envelope 仍可在 `raw_archive` 冷存中保留（由 `raw-archive-audit.md` 定义）

## 4. Tier Transitions

| 触发条件 | 源层 | 目标层 | 操作 |
| --- | --- | --- | --- |
| `received_at` > 7 天 | 热 | 温 | 自动标记，无需数据移动 |
| `received_at` > 30 天 | 温 | 冷 | 后台任务导出到外部冷存，SQLite 行删除 |
| `received_at` > 90 天 | 冷 | 删除 | 冷存对象按生命周期策略删除 |
| 手动 replay 请求 | 冷 | 临时热区 | 加载指定时间范围到本地临时表 |
| 手动 admin 保留标记 | 任意 | 延长保留 | 跳过自动删除，保留至标记取消 |

## 5. Replay Metadata

无论在哪一层，以下元数据始终保留（若事件存在）：

- `event_id`
- `received_at`
- `source_kind`
- `replay_count`
- `last_replayed_at`
- `archived`

原始 `envelope` 在冷层和删除层不再可随机访问，但元数据可在审计日志中追溯。

## 6. Operational Notes

- 热→温转换是逻辑标记，不移动数据
- 温→冷转换是物理导出，需保证幂等（同一事件不重复导出）
- 冷存分片命名需包含 `content_hash` 前缀，便于去重校验
- 删除层的事件若后续被 replay 请求引用，应返回 `410 Gone` 语义（已永久删除）
