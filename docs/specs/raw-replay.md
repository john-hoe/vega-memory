# Raw Replay Strategy

Status: accepted design spec  
Scope: raw_inbox replay trigger scenarios, scope isolation, progress tracking  
Non-goals: define candidate/promoted replay, or downstream re-derivation logic

## 1. Goal

Define when and how raw_inbox events are replayed through the ingestion pipeline, including trigger scenarios, isolation rules, and progress tracking.

## 2. Replay Trigger Scenarios

### 2.1 Schema 变更（Schema Change Replay）

**触发条件：**

- `raw_inbox` 表结构发生向后不兼容变更（如新增必填字段、删除字段、修改字段类型）
- `candidate` 或 `promoted` 层的提取规则发生变更（如 `raw_dedup_key` 算法升级、`semantic_fingerprint` 模型版本更新）

**Replay 范围：**

- 默认：最近 30 天内（温层）的全部事件
- 可配置：扩展至 90 天（冷层），需先加载回临时热区
- 排除：已物理删除（> 90 天）且未在冷存保留的事件

**隔离规则：**

- 使用独立的数据库连接或事务隔离级别 `SERIALIZABLE`
- 写入目标为临时 `candidate_replay_{timestamp}` 表，不直接覆盖现有 `candidate`
- 验证通过后，原子性交换（`RENAME TABLE` 或事务内 `DELETE + INSERT`）

**进度跟踪：**

- 在 `raw_inbox` 中更新 `replay_count += 1` 和 `last_replayed_at = now`
- 写入 `replay_log` 表（或等效审计面）：
  - `replay_id`（UUID）
  - `trigger_reason = 'schema_change'`
  - `scope_start`、`scope_end`（时间范围）
  - `total_events`、`processed_events`、`failed_events`
  - `status`：`running` / `completed` / `failed` / `cancelled`
  - `created_at`、`completed_at`

### 2.2 Pipeline Bug 修复（Pipeline Bug Repair Replay）

**触发条件：**

- 发现 ingestion pipeline 中存在 bug，导致特定时间窗口内的事件被错误丢弃、错误去重、或错误分类
- bug 修复后，需要重新处理受影响的事件

**Replay 范围：**

- 精确范围：由 bug 报告确定的时间窗口 + `source_kind` 过滤
- 例如："2026-04-01 至 2026-04-15 之间所有 `source_kind = 'mcp'` 的事件"
- 若时间窗口跨越温/冷边界，先加载冷层数据到临时热区

**隔离规则：**

- 与 Schema 变更 replay 相同：临时表 + 原子交换
- 额外要求：
  - 若 bug 导致错误 promotion，需先回滚对应的 `promoted` 记录（软删除或标记 `invalidated`）
  - 回滚和 replay 必须在同一事务内完成，保证一致性

**进度跟踪：**

- 与 Schema 变更 replay 相同，但 `trigger_reason = 'pipeline_bug'`
- 额外字段：
  - `bug_ticket_id`（如 GitHub issue 编号）
  - `rollback_count`（回滚的 promoted 记录数）
  - `re_promotion_count`（重新 promotion 的记录数）

### 2.3 手动/管理员 Replay（Manual/Admin Replay）

**触发条件：**

- 运维人员或管理员手动发起 replay 请求
- 典型场景：
  - 数据恢复演练
  - 合规审计要求重新处理特定事件
  - 新 feature flag 开启后，对历史事件进行补录

**Replay 范围：**

- 完全由管理员指定：
  - 时间范围（可跨越热/温/冷层）
  - `source_kind` 过滤
  - 特定 `event_id` 列表（精确 replay）
- 跨冷层时，需先执行冷层加载，加载完成后才能开始 replay

**隔离规则：**

- 与自动 replay 相同：临时表 + 原子交换
- 额外要求：
  - 手动 replay 必须附带 `admin_user_id` 和 `justification` 字段，用于审计
  - 大范围手动 replay（> 1000 条事件）需二次确认（如 `--force` 标志或交互式确认）

**进度跟踪：**

- 与 Schema 变更 replay 相同，但 `trigger_reason = 'manual_admin'`
- 额外字段：
  - `admin_user_id`
  - `justification`
  - `approval_status`：`pending` / `approved` / `rejected`

## 3. Replay 通用约束

### 3.1 幂等性

- 同一事件多次 replay 必须产生相同的 `candidate` 和 `promoted` 结果（在相同 schema 和规则版本下）
- 若规则版本已变更，replay 结果可能不同，这是预期行为

### 3.2 性能约束

- 热层 replay：单事件 < 10ms
- 温层 replay：单事件 < 50ms
- 冷层 replay：受限于加载速度，单事件 < 500ms（含加载时间）
- 并发 replay：同一项目同一时间只允许一个 replay 任务运行

### 3.3 错误处理

- 单事件失败不中断整个 replay 任务
- 失败事件写入 `replay_failed_events` 表：
  - `replay_id`（FK）
  - `event_id`
  - `error_message`
  - `failed_at`
- 任务结束后，`failed_events > 0` 则 `status = 'completed_with_errors'`

## 4. 与现有代码的关系

- `src/ingestion/replay.ts` 已实现基础 replay 逻辑（`replayFromRawInbox`）
- 当前实现仅支持 classifier_version/score_version 作为 metadata 的 stub forward-compat
- 本 spec 定义的场景和约束将在后续实现中逐步落地
