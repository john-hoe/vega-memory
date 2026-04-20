# Batch 12b — HostMemoryFileAdapter watcher + per-surface docs + comprehensive tests (P8-028.8 + P8-028.9 closure)

## Context

12a (commits `93bdd09` + `8d93e6c`) shipped P8-028.1-.7: adapter contract, file discovery, parser, FTS5 migration, SourceRecord assembly, ranker floor restored, profile `default_sources` restored. Known limitations left 2 gaps — P8-028.8 (comprehensive tests + per-surface path docs) and P8-028.9 (index refresh / invalidation strategy).

12a Known #3 explicitly deferred watcher: *"Index refresh 只在 adapter construct 时发生；process 跑起来之后文件变化不会触发 re-index（12b 加 watcher / debounce / manual refresh）"*.

This batch closes both subs + seals P8-028 parent.

## Scope

### 1. `src/retrieval/sources/host-memory-file.ts` — lifecycle + poll-driven refresh

- Add private `#pollTimer: NodeJS.Timeout | null` field and private `#pollIntervalMs: number` (default **30000ms**, configurable via `VEGA_HOST_MEMORY_FILE_POLL_INTERVAL_MS`).
- Env parse rule (strict, aligned with semantic-dimension.ts:121 pattern): `Number.parseInt(env, 10)`; accept only **`parsed > 0`**; otherwise fall back to default. Do NOT accept `0` or negative.
- On construct: if `enabled === true`, start `setInterval(() => this.refreshIndex(), pollIntervalMs)`. Keep existing synchronous construction-time refresh call — poll is for *changes after startup*.
- Public `dispose()` method: `clearInterval(this.#pollTimer)`; idempotent (calling twice is no-op); safe when adapter was never started.
- Make `refreshIndex()` safe under concurrent invocation (e.g., if manual refresh fires while poll is running): simple mutex flag `#refreshInFlight` — if already refreshing, skip this tick. Do NOT queue.
- `enabled === false` path: never start timer; `dispose()` still safe.

### 2. `src/mcp/server.ts` — new tool `host_memory_file.refresh`

Register under the same MCP tool registry pattern as `reconciliation.run`:
- Tool name: **`host_memory_file.refresh`** (dot-separated like `reconciliation.run`)
- Zod input: `{}` (no args) — simplest surface for manual trigger
- Handler: call `hostMemoryFileAdapter.refreshIndex()`; return `{ schema_version: "1.0", refreshed_at: <ISO>, indexed_paths: <number>, duration_ms: <number>, degraded?: "adapter_disabled" | "sqlite_only" }`.
- `enabled === false` → `{ degraded: "adapter_disabled", ...timing }`, no throw.
- Postgres path → `{ degraded: "sqlite_only", ...timing }`, no throw.
- Scope tight: **only ONE new tool registration** in `src/mcp/server.ts`. Do NOT touch any other existing tool wiring.

### 3. Adapter dispose wiring — `src/api/server.ts` + `src/mcp/server.ts` shutdown path

Both runtime entrypoints currently build adapter via `new HostMemoryFileAdapter(...)`. On shutdown / process SIGTERM / test cleanup, `dispose()` must be invoked to let the interval clear and prevent `--detectOpenHandles` false positives.

- `src/api/server.ts`: if APIServer has a `stop()` / `close()` method, invoke adapter `dispose()` there. If not, expose adapter on returned handle so caller can dispose. Minimize invasiveness.
- `src/mcp/server.ts`: analogous for MCP server lifecycle.
- If adding lifecycle hook to API/MCP server requires more than ~10 lines, prefer exposing adapter on the returned server handle instead (let the caller decide). Document decision in commit body.

### 4. New file `docs/adapters/host-memory-file.md` — per-surface reference doc

Mandatory sections (grep-checkable headings):
1. **Overview** — 1 para on what the adapter does + what it doesn't do (read-only, never writes host files — ties to P8-030 in future).
2. **Surfaces** — a table with columns: `surface_name | path_pattern | format | example` for all 5 enumerated surfaces (cursor / codex / claude / claude-projects / omc). Path pattern uses the exact `HOST_MEMORY_FILE_PATH_SPECS` strings (cross-reference source).
3. **Parser behavior** — markdown frontmatter / plain text / JSON — note YAML errors warn+fallback.
4. **FTS index lifecycle** — construct: full re-index; poll: mtime-based sparse re-index; manual: via MCP tool `host_memory_file.refresh`.
5. **Configuration envs** — list all 2 env vars (`VEGA_HOST_MEMORY_FILE_ENABLED`, `VEGA_HOST_MEMORY_FILE_POLL_INTERVAL_MS`) with default + valid ranges.
6. **Known limitations** — copy the 7 from 12a commit body verbatim (reference for user).

Target size: ~150-250 lines. Chinese preferred to match brief convention; code snippets English.

### 5. `src/tests/host-memory-file-adapter.test.ts` — 3+ new test cases (append to existing 8)

- **Poll-driven refresh**: construct adapter with `pollIntervalMs: 50ms` override; write a new host file to tmp HOME *after* adapter construct; wait ~200ms; `adapter.search(...)` returns the new content. `dispose()` before test ends.
- **Dispose idempotent**: call `dispose()` twice — no throw, no side effect.
- **Concurrent refresh safety**: trigger `refreshIndex()` + manual tool call overlap (spawn 5 parallel `await adapter.refreshIndex()` calls); assert no throw, assert file count in `host_memory_file_entries` matches expected (no duplicates / no race corruption).

### 6. New file `src/tests/host-memory-file-mcp-refresh.test.ts` — MCP tool surface test

- 3 test cases minimum:
  - Happy path: adapter enabled + SQLite → tool returns `{schema_version, refreshed_at, indexed_paths >= 0, duration_ms >= 0}`, no `degraded`.
  - Adapter disabled: tool returns `degraded: "adapter_disabled"`, no throw.
  - Postgres stub: `db.isPostgres = true` → tool returns `degraded: "sqlite_only"`, no throw.

### 7. Env var constant — inline or export

`VEGA_HOST_MEMORY_FILE_POLL_INTERVAL_MS` parsing must be tested: at least 2 cases in an existing test file (adapter or new env-focused) — `env="0"` and `env=""` both fall back to 30000.

## Out of scope — do NOT touch

- `src/reconciliation/**` (byte-locked since 11a)
- `src/monitoring/vega-metrics.ts` / `metrics-fingerprint.ts` / `metrics.ts` / `dashboards/**`
- `src/scheduler/**` except `src/scheduler/index.ts` — and **even `index.ts` must stay byte-identical to 8d93e6c** (no scheduler-level lifecycle plumbing; adapter self-manages)
- `src/notify/**` / `src/db/migrations/**` / `src/core/contracts/**`
- `src/retrieval/profiles.ts` / `src/retrieval/ranker-score.ts` / `src/retrieval/orchestrator.ts` / `src/retrieval/orchestrator-config.ts` / `src/retrieval/sources/registry.ts` / `src/retrieval/sources/host-memory-file-paths.ts` / `src/retrieval/sources/host-memory-file-parser.ts` / `src/retrieval/sources/host-memory-file-fts.ts` (all correct from 93bdd09 / 8d93e6c)
- `src/index.ts` / `src/api/mcp.ts`
- All existing test files except `src/tests/host-memory-file-adapter.test.ts` (allowed additions, keep existing 8 untouched)

## Forbidden files

All prior batch Out-of-scope lists (inherited). Specifically:
- `src/reconciliation/**` (full lockdown)
- `src/monitoring/vega-metrics.ts` / `metrics-fingerprint.ts` / `metrics.ts` / `dashboards/**`
- `src/scheduler/**` (entire directory, even `index.ts` byte-locked in this batch)
- `src/notify/**` / `src/db/migrations/**` / `src/core/contracts/**`
- `src/retrieval/*` except `src/retrieval/sources/host-memory-file.ts` (only this file in retrieval/sources is mutable; helpers + fts + paths + parser byte-locked)
- Existing tests (retrieval-*.test.ts / reconciliation-*.test.ts / monitoring-*.test.ts / etc.) — only `host-memory-file-adapter.test.ts` allowed extra cases
- Root-level markdown files
- `docs/**` except this brief + `docs/adapters/host-memory-file.md`

## Forbidden patterns (Wave 5 全程继续)

- Production 代码不得嗅探测试环境
- 测试不得触碰 macOS 真实钥匙串 / 真实 HOME / 真实 user config（poll test 用 mkdtempSync tmp HOME）
- 不 amend 8d93e6c / c349fd5；新起 commit 在其上
- Watcher 必须用 `setInterval` polling（不得用 `fs.watch` / chokidar / fsevents — 跨平台可靠性 + 依赖面避雷）
- `refreshIndex()` 并发安全走 in-memory flag（不得引入 db-level lock / 新表）

## Acceptance criteria

1. `grep -nE '#pollTimer|#pollIntervalMs|#refreshInFlight' src/retrieval/sources/host-memory-file.ts` ≥ 3 处命中
2. `grep -nE 'setInterval' src/retrieval/sources/host-memory-file.ts` ≥ 1 处；`grep -nE 'fs\.watch|chokidar|fsevents' src/retrieval/sources/host-memory-file.ts` **零**命中
3. `grep -nE 'dispose\s*\(\s*\)' src/retrieval/sources/host-memory-file.ts` ≥ 1 处（public 方法签名 + body）
4. `grep -nE 'VEGA_HOST_MEMORY_FILE_POLL_INTERVAL_MS' src/retrieval/sources/host-memory-file.ts` ≥ 1 处；env parse 用 `parsed > 0` 守卫（grep `parsed\s*>\s*0` ≥ 1）
5. `grep -nE 'host_memory_file\.refresh' src/mcp/server.ts` ≥ 1 处（新 tool 注册）
6. `docs/adapters/host-memory-file.md` 存在；grep 6 个 section headings: `## Overview` / `## Surfaces` / `## Parser behavior` / `## FTS index lifecycle` / `## Configuration envs` / `## Known limitations` 各 ≥ 1 处；surface 表至少列 5 行 (cursor / codex / claude / claude-projects / omc)
7. `grep -c '^test(' src/tests/host-memory-file-adapter.test.ts` ≥ 11（原 8 + 新 3）
8. `src/tests/host-memory-file-mcp-refresh.test.ts` 存在；`grep -c '^test(' src/tests/host-memory-file-mcp-refresh.test.ts` ≥ 3
9. `git diff HEAD -- src/` 仅涉及 `src/retrieval/sources/host-memory-file.ts` + `src/mcp/server.ts` +（可选 `src/api/server.ts`）+ 新测试文件。其他 src/ 零变动
10. `git diff HEAD -- src/reconciliation/ src/monitoring/ dashboards/ src/scheduler/ src/notify/ src/db/migrations/ src/core/contracts/ src/retrieval/profiles.ts src/retrieval/ranker-score.ts src/retrieval/orchestrator.ts src/retrieval/orchestrator-config.ts src/retrieval/sources/registry.ts src/retrieval/sources/host-memory-file-paths.ts src/retrieval/sources/host-memory-file-parser.ts src/retrieval/sources/host-memory-file-fts.ts src/index.ts src/api/mcp.ts` 输出为空
11. `git diff HEAD -- src/tests/` 仅显示 `host-memory-file-adapter.test.ts` + 新 `host-memory-file-mcp-refresh.test.ts`；其他 test 文件零变动
12. `set -o pipefail; npm run build` 成功退出；`set -o pipefail; npm test` 全绿（预期 ≥ 1056 pass）
13. 严格**不 amend** `8d93e6c` / `c349fd5`；新起 commit 叠在其上
14. Commit title 前缀 `feat(retrieval):`
15. Commit body：
    ```
    Closes P8-028.8 (comprehensive tests + per-surface file path docs) and
    P8-028.9 (index refresh / invalidation strategy) via:
    - setInterval-based polling (30s default, VEGA_HOST_MEMORY_FILE_POLL_INTERVAL_MS
      override with `parsed > 0` guard) self-managed inside HostMemoryFileAdapter
      with a dispose() public API. fs.watch / chokidar avoided — setInterval
      uses only the mtime bookkeeping already present in host_memory_file_entries.
    - Concurrent refresh safety via in-memory #refreshInFlight flag (no DB-level
      lock, no queue). Manual and polled refreshes coalesce safely.
    - New MCP tool `host_memory_file.refresh` (schema_version "1.0") following
      reconciliation.run pattern. Returns refreshed_at / indexed_paths /
      duration_ms plus degraded:"adapter_disabled" or "sqlite_only" where
      applicable, never throws.
    - New docs/adapters/host-memory-file.md enumerates all 5 surfaces (paths,
      formats, examples), parser behavior, FTS index lifecycle, 2 env vars,
      and carries forward the 7 Known limitations from 12a.
    - Tests: 3 new adapter cases (poll-driven refresh, dispose idempotent,
      concurrent refresh race safety) and a new host-memory-file-mcp-refresh
      test file with 3 MCP surface cases. Build + test green (≥1056 pass).

    Seals P8-028 parent; scheduler unchanged from 12a.1 (adapter self-lifecycle).

    Scope-risk: low
    Reversibility: clean
    ```

## Review checklist

- Watcher 用 `setInterval` 而非 `fs.watch` / chokidar 吗？
- `pollIntervalMs` 的 env 走 `parsed > 0` fallback（不是 `>= 0`）吗？
- `dispose()` 是 idempotent 吗？（test case 覆盖）
- `#refreshInFlight` mutex 是否简单 in-memory flag（非 DB 锁、非队列）？
- 新 MCP tool name 是 `host_memory_file.refresh`（dot-separated 对齐 `reconciliation.run`）吗？
- `docs/adapters/host-memory-file.md` 的 5 个 surface table row 是否来自 `HOST_MEMORY_FILE_PATH_SPECS`（不是硬编码另一份）？
- 新 test file 的 3 个 case 是否均用 `mkdtempSync` + stub `DatabaseAdapter`（Postgres path 走 stub flag `isPostgres: true`）？
- 是否零 touch scheduler / reconciliation / monitoring / profiles / ranker 等所有 byte-locked 区？
- 新 commit 叠 `c349fd5` 下方，不 amend？

## Commit discipline

- 单 atomic commit，新起
- 前缀 `feat(retrieval):`
- body 按 Acceptance #15
- 不创建 root-level markdown / 其他 docs 除 `docs/adapters/host-memory-file.md`
