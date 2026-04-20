## Overview

`HostMemoryFileAdapter` 用来把宿主机上的少量“agent memory / notes”文件映射成只读 retrieval source，
并写入 SQLite FTS 索引，供 `context.resolve`、MCP retrieval、API retrieval 在查询时命中。
它只负责发现、解析、索引、搜索，不负责写回宿主文件，也不会修改用户的 `~/.cursor`、`~/.codex`、
`~/.claude`、`~/.omc` 内容；写回与双向同步能力留给未来的 P8-030 之类后续工作。

当前实现是 read-only adapter：

- 读取真实 host files
- 解析 markdown frontmatter / plain text / JSON
- 维护 SQLite FTS5 side index
- 在 source search 时返回 `SourceRecord`

当前实现明确不做：

- 不写入 host memory files
- 不做 file watcher callback 链路
- 不做 debounce queue
- 不做 DB-level lock
- 不做 embedding enrichment

这意味着它更像一个轻量的“宿主文件检索镜像层”，而不是一个 host-memory authoring system。

## Surfaces

下面这张表直接对应 `HOST_MEMORY_FILE_PATH_SPECS` 中当前生效的 5 个 surface。
`path_pattern` 一列使用源码中的精确字符串；如果未来源码改动，这份文档也必须一起更新。

| surface_name | path_pattern | format | example |
| --- | --- | --- | --- |
| cursor | `~/.cursor/rules/memory.mdc` | markdown frontmatter | `~/.cursor/rules/memory.mdc` |
| codex | `~/.codex/AGENTS.md` | plain text | `~/.codex/AGENTS.md` |
| claude | `~/.claude/CLAUDE.md` | plain text | `~/.claude/CLAUDE.md` |
| claude-projects | `~/.claude/projects/*/memory/*.md` | markdown frontmatter | `~/.claude/projects/demo-repo/memory/notes.md` |
| omc | `~/.omc/notepad.md` | plain text | `~/.omc/notepad.md` |

说明：

- `cursor` 走单文件路径。
- `codex` 走单文件路径。
- `claude` 走单文件路径。
- `claude-projects` 走 `*` glob 展开，会枚举多个 project memory 文件。
- `omc` 走单文件路径。

surface 到 parser 的绑定关系目前固定在路径 spec 上，而不是通过文件扩展名动态猜测。
因此 `.mdc`、`.md`、`.json` 的语义都来自源码配置，不来自 runtime sniffing。

## Parser behavior

Adapter 当前支持 3 类 parser：

1. `markdown_frontmatter`
2. `plain_text`
3. `json`

### markdown frontmatter

适用于：

- `~/.cursor/rules/memory.mdc`
- `~/.claude/projects/*/memory/*.md`

行为：

- 尝试解析 YAML frontmatter
- 若存在 `title`，优先作为 indexed title
- body 使用 frontmatter 之后的 markdown 内容
- frontmatter 中的其他字段保留在 parser 内部结果里，但当前索引只消费 `title + body`

YAML 解析失败时不会中断整个 refresh：

- parser 记录 warning
- 内容退化为 plain body/fallback body
- 单文件失败不会阻断其他文件刷新

### plain text

适用于：

- `~/.codex/AGENTS.md`
- `~/.claude/CLAUDE.md`
- `~/.omc/notepad.md`

行为：

- 第一行可作为 title 候选
- 剩余文本作为 body
- 不要求 frontmatter

### json

当前 parser 代码支持 JSON surface，但本批次 5 个默认 path spec 没有启用 JSON 路径。
保留该 parser 是为了后续新增 host surface 时不必重写 adapter 主链路。

行为：

- 期待对象型 JSON
- 可提取 `title`
- 其余内容退化为可搜索文本
- malformed JSON 时 warn + fallback，而不是 hard fail

## FTS index lifecycle

当前索引生命周期分 3 个入口：

### Construct-time full refresh

Adapter 构造时，如果 `enabled === true`：

- 先执行一次同步 `refreshIndex()`
- 对当前 discover 到的全部 host files 做全量扫描
- 为每个 path 记录 `mtime_ms`、`indexed_at`、`file_size_bytes`、`content_sha256`
- 同步维护 `host_memory_file_entries` 和 `host_memory_file_fts`

这一步保证服务刚启动时就能立刻搜索到已有 host memory 文件。

### Poll-time sparse refresh

构造完成后，adapter 会启动 `setInterval` polling。

行为：

- 默认间隔 `30000ms`
- 可用 `VEGA_HOST_MEMORY_FILE_POLL_INTERVAL_MS` 覆盖
- 只接受 `parsed > 0`
- `0`、负数、空串、非法值都会回退到默认值 `30000`

每次 poll refresh 不是盲目重建整表，而是走 mtime-based sparse re-index：

- 若 path 新出现：插入 entry + FTS row
- 若 path 已存在且 `mtime_ms` 未变化：跳过
- 若 path 已存在且 `mtime_ms` 变化：只重建该 path 的 entry / FTS row
- 若 path 已消失：删除 stale entry / FTS row

并发上，manual refresh 与 poll refresh 通过内存态 `#refreshInFlight` 合并：

- 已在 refresh 中时，后续 refresh 直接 skip
- 不排队
- 不引入 DB-level lock

### Manual refresh via MCP

MCP surface 暴露 `host_memory_file.refresh`。

调用后会：

- 触发一次显式 `refreshIndex()`
- 返回 `schema_version: "1.0"`
- 返回 `refreshed_at`
- 返回 `indexed_paths`
- 返回 `duration_ms`

degraded 路径：

- adapter 被 env 禁用时：`degraded: "adapter_disabled"`
- Postgres runtime 时：`degraded: "sqlite_only"`

这两个 degraded 路径都不会抛异常。

## Configuration envs

当前只使用 2 个 env：

| env | default | valid values | effect |
| --- | --- | --- | --- |
| `VEGA_HOST_MEMORY_FILE_ENABLED` | enabled | `"false"` disables; any other value or unset keeps enabled on SQLite | 总开关；Postgres 下即使不是 `"false"` 也会因 SQLite-only 约束而不可用 |
| `VEGA_HOST_MEMORY_FILE_POLL_INTERVAL_MS` | `30000` | `Number.parseInt(env, 10)` 且 `parsed > 0` | 设置 poll 间隔；非法值回退到 `30000` |

几个实际例子：

```bash
VEGA_HOST_MEMORY_FILE_ENABLED=false
```

```bash
VEGA_HOST_MEMORY_FILE_POLL_INTERVAL_MS=5000
```

```bash
VEGA_HOST_MEMORY_FILE_POLL_INTERVAL_MS=0
# falls back to 30000
```

```bash
VEGA_HOST_MEMORY_FILE_POLL_INTERVAL_MS=
# falls back to 30000
```

如果 runtime 使用 Postgres：

- adapter 不初始化 FTS5 表
- MCP manual refresh 返回 `sqlite_only`
- search surface 等价于 disabled

## Known limitations

以下 7 条从 12a commit body 原样带过来，作为当前用户可见限制：

1. **只做 .1-.7 核心链路**；comprehensive tests + per-surface 文件路径文档 + invalidation strategy (watcher / debounce / manual CLI) 延到 Batch 12b
2. **Embedding hook 未接入**；P8-028.4 备注里的"可选"embedding 待评估 12b 或 Wave 6
3. **Index refresh 只在 adapter construct 时发生**；process 跑起来之后文件变化不会触发 re-index（12b 加 watcher / debounce）
4. **`.cursor/rules/memory.mdc`**：扩展名 `.mdc` 非 `.md`（宿主侧原生格式），parser 按 markdown_frontmatter 处理；未来若宿主改 `.md` 扩展，需同步更新 HOST_MEMORY_FILE_PATH_SPECS
5. **~/.claude/projects/*/memory/*.md glob**：可能匹配大量小文件；本批次不加 file count cap，依赖用户环境合理（12b 若需加 cap 再引入）
6. **Ranker floor = 0.05**：凭 Wave 3 直觉经验值，未经生产数据调校；12b 或后续 sunset 观察再调（GitHub #44 告警 wiring 也相关）
7. **SQLite-only**（继承 11a-11c 约束）；Postgres path 不初始化 FTS5 表，adapter `enabled = false`

补充说明：

- 第 1 条与第 3 条在本批次已有部分收敛：tests、per-surface docs、manual MCP refresh、poll refresh 已补齐。
- 但上面的 7 条这里保持 verbatim 复制，以保留 12a 原始上下文。
- 如果后续要更新这些限制，请直接在下一批提交里同时更新 commit body 与本页，避免文档和 git lore 漂移。
