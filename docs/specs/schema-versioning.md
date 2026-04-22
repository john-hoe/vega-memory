# Schema 版本演进与兼容策略

> P5-001.1.3 — 定义 `schema_version` 在宿主 envelope、bundle 及下游 contract 中的演进规则。

## 1. 版本号规则

采用类 SemVer 的三段式版本号：

```
MAJOR.MINOR.PATCH
```

- **MAJOR**：破坏性变更（breaking change），旧版本解析器必须拒绝或进入降级路径。
- **MINOR**：新增字段或扩展，旧版本解析器必须能**安全忽略**未知字段（forward compatibility）。
- **PATCH**：文档修正、描述调整、默认值变化，不影响运行时行为。

## 2. 向前兼容原则

- 任何 MINOR 或 PATCH 升级，旧解析器必须能继续解析新版本 payload。
- 实现方式：
  - 解析器使用 `stripUnknown: true` 或等效策略，忽略未声明字段。
  - 新增字段必须带合理的默认值或允许 `undefined`。
- 宿主 SDK 在生成 envelope 时，必须显式写入当前 `schema_version`，不得省略。

## 3. 废弃与移除流程

| 阶段 | 动作 | 最短周期 |
|------|------|----------|
| 1. 标记废弃 | 在文档和 schema 中标注 `deprecated`，并在解析时发出 warning | — |
| 2. 兼容保留 | 至少保留一个 MAJOR 版本的兼容解析 | 1 个 MAJOR 周期 |
| 3. 正式移除 | 在新 MAJOR 版本中移除字段或变更语义，旧解析器必须拒绝 | — |

- 废弃字段在 schema 中保留，但标注 `deprecated: true`。
- Vega 侧在 ingestion 时记录 `schema.deprecated_field_used` 事件，供运营分析。

## 4. v1 → v2 迁移示例

### 当前 v1.0（Phase 5 基线）

```json
{
  "schema_version": "1.0",
  "event_id": "...",
  "surface": "claude",
  "session_id": "...",
  "thread_id": null,
  "project": null,
  "cwd": null,
  "timestamp": "2026-04-22T00:00:00Z",
  "role": "assistant",
  "event_type": "task.completed",
  "payload": { ... },
  "safety": { "redaction_applied": false, "truncated": false },
  "artifacts": []
}
```

### 假设 v2.0（未来 MAJOR 升级）

变更：
- 将 `safety` 从扁平对象升级为嵌套对象，增加 `encryption` 子字段。
- 移除 `cwd` 字段（宿主不再提供）。
- 新增 `delivery_context` 对象，包含 `retry_count` 和 `offline_queued`。

```json
{
  "schema_version": "2.0",
  "event_id": "...",
  "surface": "claude",
  "session_id": "...",
  "thread_id": null,
  "project": null,
  "timestamp": "2026-04-22T00:00:00Z",
  "role": "assistant",
  "event_type": "task.completed",
  "payload": { ... },
  "safety": {
    "redaction_applied": false,
    "truncated": false,
    "encryption": { "algorithm": "none" }
  },
  "artifacts": [],
  "delivery_context": { "retry_count": 0, "offline_queued": false }
}
```

### 迁移路径

1. **v1.x 阶段**：在 MINOR 版本中先新增 `delivery_context`（可选），旧解析器忽略。
2. **v2.0 发布**：`delivery_context` 变为必填，`safety` 结构变更，`cwd` 正式移除。
3. **Vega 侧**：`VersionedDispatcher` 注册 v2.0 解析器；v1.0 解析器继续保留至少一个 MAJOR 周期。
4. **宿主侧**：宿主 SDK 逐步升级，先支持发送 v2.0，再停止发送 v1.0。

## 5. 与现有代码的关系

- 当前 `src/core/contracts/schema-version.ts` 中的 `VersionedDispatcher` 已支持多版本注册与分发。
- `createDefaultEnvelopeDispatcher()` 注册了 `"1.0"` 版本。
- 未来新增版本时，只需调用 `dispatcher.register({ version: "2.0", schema: ... })` 即可。

## 6. 一句话版本

`schema_version` 按 MAJOR.MINOR.PATCH 演进：MINOR  additive、forward compatible；MAJOR  breaking、需保留兼容解析至少一个周期；废弃字段先标后删，Vega 侧用 `VersionedDispatcher` 分发。
