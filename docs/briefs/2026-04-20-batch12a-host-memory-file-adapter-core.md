# Batch 12a — HostMemoryFileAdapter core live (P8-028.1-.7)

## Context
P8-032 Reconciliation 5-matrix sealed via 11a-11c stack (commits `fc52ad7..c34c802`). Wave 5 2/12 parents closed; 10 parents to go. Next parent: **P8-028 宿主记忆 reader** (E 边界 group starter — unlocks P8-030/.031 after closure).

Landscape scan confirms:
- `SOURCE_KINDS` already contains `"host_memory_file"`（src/core/contracts/enums.ts:14）→ **无需 P8-029a 预备批**
- Stub adapter returns `enabled: false` 在 `src/retrieval/sources/host-memory-file.ts`
- Profiles.ts 有 TODO 注释 explicitly waiting for P8-028 to re-add `host_memory_file`
- Ranker `source_prior = 0.3` 已就位
- **6 处 existing tests** assert `enabled=false` / `profile excludes host_memory_file` / `budget_reserved=0` — 必须随 adapter 恢复而更新

This batch (12a) ships sub-tasks **.1-.7**（adapter 接口 / path 发现 / format 解析 / FTS5 索引 / SourceRecord 组装 / ranker floor 恢复 / profile default_sources 恢复）+ breaking test fixes. Sub-tasks .8 (comprehensive tests + per-surface docs) + .9 (runtime watcher / debounce / manual refresh) are deferred to **Batch 12b**.

## Scope

### 1. New FTS5 virtual table via new module
New file `src/retrieval/sources/host-memory-file-fts.ts`:
- Export `HOST_MEMORY_FILE_FTS_TABLE = "host_memory_file_fts"` + `HOST_MEMORY_FILE_ENTRIES_TABLE = "host_memory_file_entries"` constants
- Export `applyHostMemoryFileFtsMigration(db: DatabaseAdapter): void` following the same additive pattern as `applyRawInboxMigration` / `applyReconciliationFindingsMigration`
- Two tables:
  ```sql
  CREATE VIRTUAL TABLE IF NOT EXISTS host_memory_file_fts USING fts5(
    path UNINDEXED,
    surface UNINDEXED,
    title,
    content,
    tokenize='porter unicode61'
  );
  CREATE TABLE IF NOT EXISTS host_memory_file_entries (
    path TEXT PRIMARY KEY,
    surface TEXT NOT NULL,
    mtime_ms INTEGER NOT NULL,
    indexed_at INTEGER NOT NULL,
    file_size_bytes INTEGER NOT NULL,
    content_sha256 TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS host_memory_file_entries_surface_idx ON host_memory_file_entries (surface);
  ```
- Migration wired in `src/api/server.ts` + `src/mcp/server.ts` next to existing migrations (SQLite-only; Postgres skip)

### 2. Per-surface path discovery — new module
New file `src/retrieval/sources/host-memory-file-paths.ts`:
- Export `HOST_MEMORY_FILE_PATH_SPECS: readonly PathSpec[]` const, each spec:
  ```ts
  { surface: Surface, pattern: string, parser: "markdown_frontmatter" | "plain_text" | "json" }
  ```
- Encode the 5 surface path rules:
  - **cursor**: `~/.cursor/rules/memory.mdc` (note: `.mdc` not `.md`; constants already in integration-surface-status.ts reuse as source of truth if clean, else define here)
  - **codex**: `~/.codex/AGENTS.md`
  - **claude**: `~/.claude/CLAUDE.md`
  - **claude-projects**: `~/.claude/projects/*/memory/*.md` (glob with recursive)
  - **omc**: `~/.omc/notepad.md`
- Export `enumeratePaths(homeDir: string): { surface: Surface; path: string; parser: PathSpec["parser"] }[]` that expands globs and returns absolute paths
- `homeDir` parameter injected (NOT reading `os.homedir()` at module load — tests need to inject tmp HOME)

### 3. Format parsers — new module
New file `src/retrieval/sources/host-memory-file-parser.ts`:
- Export `parseMarkdownFrontmatter(content: string): { title?: string; body: string; frontmatter: Record<string, unknown> }`
- Export `parsePlainText(content: string): { title?: string; body: string }` (title = first non-empty line, body = rest)
- Export `parseJson(content: string): { title?: string; body: string }` (title = `title` field if present, body = stringified minus title)
- All parsers **log warn and return { body: rawContent, title: undefined }** on error — do NOT throw. File cannot be excluded silently.

### 4. Rewrite HostMemoryFileAdapter
File `src/retrieval/sources/host-memory-file.ts` — replace stub with real impl:
- Constructor receives `{ db: DatabaseAdapter, homeDir: string }` options
- Adapter stores db reference; does NOT cache index in memory (FTS5 is source of truth for queries)
- `enabled`: computed `true` **unless** `process.env.VEGA_HOST_MEMORY_FILE_ENABLED === "false"` (Q3 α — default on; explicit opt-out via env)
- On construct: call `refreshIndex()` **once** (does sparse mtime-based re-index; see below)
- `search(query, limit)`: query FTS5 via `bm25()` ranking, return top N as SourceRecord array
- `refreshIndex()` implementation (sparse):
  - Enumerate paths via `enumeratePaths(this.homeDir)`
  - For each discovered file: `stat` → compare with `host_memory_file_entries.mtime_ms`; if new/changed: read → parse → compute sha256 → upsert entries + delete/insert FTS5 row
  - For each entry row whose path no longer exists: delete FTS5 row + entry row
  - All ops in a single transaction via `db.transaction(() => ...)`
- Graceful degradation: any individual file read/parse error → log warn + skip that file (don't abort the whole index refresh)

### 5. SourceRecord assembly
BundleRecord shape:
- `id`: synthetic `host-memory-file:${path}:${line_range_or_0}` (stable across runs for dedup / citation)
- `source_kind`: `"host_memory_file"`
- `content`: parsed body (trimmed if > 4096 chars, suffix `…`)
- `provenance`: `{ origin: <absolute path>, retrieved_at: <ISO timestamp of index row> }`
- `score`: optional, let ranker layer populate

### 6. Ranker host_memory_file_floor restore
File `src/retrieval/ranker.ts` or `src/retrieval/ranker-score.ts`:
- Grep for the 5g-removed `host_memory_file_floor` logic; if removed as comment, un-comment
- If fully deleted: add back a floor clause that保底 `host_memory_file` records 的 rank 分数不低于固定阈值（建议 0.05），防止被其他源完全挤出
- Must NOT change behavior for non-host_memory_file records

### 7. Profile default_sources restore
File `src/retrieval/profiles.ts`:
- Remove TODO comment at line 15-16 ("re-add host_memory_file when P8-028 implemented")
- Re-add `"host_memory_file"` to each profile's `default_sources`:
  - `BOOTSTRAP_PROFILE`: append to current 5-entry list
  - `LOOKUP_PROFILE`: append
  - `FOLLOWUP_PROFILE`: append
  - `EVIDENCE_PROFILE`: append
- Exact position (head/tail) within array: append to end (keep existing order stable)

### 8. Breaking test fixes — explicit allowance
Modify ONLY the following 6 assertion sites in existing tests — downstream necessary cleanup per Q4 α:
- `src/tests/retrieval-orchestrator-integration.test.ts:~28` — flip `enabled=false` assertion to `enabled=true`
- `src/tests/retrieval-profiles.test.ts:~26-30` — update 4 profiles to assert `host_memory_file` **IS** in default_sources
- `src/tests/retrieval-budget.test.ts:~31` — update manual-enable test expectations (adapter now always enabled; adjust what the test proves)

Do **NOT** modify other aspects of these files beyond the breaking assertions.

### 9. Minimum new adapter tests
New file `src/tests/host-memory-file-adapter.test.ts`:
- **Basic adapter activation**: `enabled === true` when env unset; `enabled === false` when `VEGA_HOST_MEMORY_FILE_ENABLED=false`
- **Path enumeration**: fixture HOME with CLAUDE.md + .cursor/rules/memory.mdc → `enumeratePaths()` finds both
- **Format parsing**: markdown with YAML frontmatter / plain text / malformed JSON各一条 → parser 返正确结构，malformed 不 throw
- **FTS5 indexing**: after adapter construct with 2 fixture files → `search("query matching file content", 5)` returns corresponding records with correct SourceRecord shape (source_kind / provenance / content)
- **Sparse re-index**: change mtime on one fixture file → new adapter construct re-indexes only that file (verify indexed_at delta)
- **Missing file cleanup**: delete a fixture file → adapter construct deletes stale entry + FTS5 row
- All tests hermetic: `:memory:` DB + tmp HOME via `mkdtempSync`; **no touching real ~/.claude / ~/.cursor / ~/.codex** (tests inject `homeDir` via adapter constructor)

## Out of scope — do NOT touch
- P8-028.8 comprehensive tests (整合 / fixture-heavy / per-surface regression) → Batch 12b
- P8-028.9 runtime watcher / debounce / manual CLI refresh → Batch 12b
- Embedding hook (P8-028.4 备注"可选" → 12b 或 Wave 6 再评估)
- 10a metrics stack / dashboards / monitoring
- 11a-11c reconciliation (全部字节锁定)
- 10a.1 revert-locked files (config.ts / keychain.ts / integration-surface-status.ts / doctor.ts) — **注意**：path constants can be re-stated in new host-memory-file-paths.ts without modifying integration-surface-status.ts
- GitHub #43 / #44 / #45 deferred items

## Forbidden files
- All prior batch Out-of-scope (inherited)
- `src/monitoring/**` / `dashboards/**` / `src/scheduler/**` / `src/notify/**` / `src/db/migrations/**` / `src/core/contracts/**`
- All `src/reconciliation/**` files (sealed)
- `src/config.ts` / `src/security/keychain.ts` / `src/core/integration-surface-status.ts` / `src/cli/commands/doctor.ts` (10a.1 revert-locked — can read constants from these, cannot modify)
- Existing `src/tests/*.test.ts` files EXCEPT the 3 listed in Scope §8 (breaking assertion sites)
- `docs/**` except this brief
- Root-level markdown files
- This brief itself

## Forbidden patterns (Wave 5 全程继续)
- Production 代码不得嗅探测试环境
- 测试严禁触碰 macOS 真实钥匙串 / 真实 HOME / 真实 user config
- Adapter `homeDir` 必须通过构造函数参数注入；**不得**在 module top-level call `os.homedir()`
- Tests 构造 adapter 时必须用 `mkdtempSync` 的临时目录，**不得**默认读真 `os.homedir()`
- Parser 错误必须 log warn + fallback，**不得** throw

## Acceptance criteria
1. 新文件 3 个：`host-memory-file-fts.ts` / `host-memory-file-paths.ts` / `host-memory-file-parser.ts`
2. `src/retrieval/sources/host-memory-file.ts` 原 stub 被重写；`enabled` 默认 true + env `VEGA_HOST_MEMORY_FILE_ENABLED=false` 可 opt-out
3. `applyHostMemoryFileFtsMigration` 在 `src/api/server.ts` + `src/mcp/server.ts` 启动处被调（sqlite-only）
4. `grep -n 'host_memory_file' src/retrieval/profiles.ts` 在每个 profile 的 default_sources 命中
5. `grep -n 'host_memory_file_floor\|HOST_MEMORY_FILE_FLOOR' src/retrieval/ranker*` 命中恢复的 floor 逻辑
6. Breaking test 仅 3 个文件的假定数据被更新（orchestrator-integration / retrieval-profiles / retrieval-budget）；其他现有测试文件**零修改**
7. 新测试 `src/tests/host-memory-file-adapter.test.ts` 覆盖 Scope §9 的 6 类 case
8. `grep -rnE 'homedir\s*\(\s*\)' src/retrieval/sources/host-memory-file*` 返回空（module top-level 不 call os.homedir）
9. `npm run build` 成功；`npm test` 全绿（预期 ≥ 1048 pass：1042 + 新测试 ≥ 6 - 但有 existing tests 断言翻转，净增略低于 6）
10. 严格**不 amend** commit `c34c802`，新起 commit 在其上
11. Commit title 前缀 `feat(retrieval):`
12. Commit body 包含 `Closes P8-028.1, P8-028.2, P8-028.3, P8-028.4, P8-028.5, P8-028.6, P8-028.7`，并原样复述下方 Known limitations

## Known limitations（必须进 commit body）
1. **只做 .1-.7 核心链路**；comprehensive tests + per-surface 文件路径文档 + invalidation strategy (watcher / debounce / manual CLI) 延到 Batch 12b
2. **Embedding hook 未接入**；P8-028.4 备注里的"可选"embedding 待评估 12b 或 Wave 6
3. **Index refresh 只在 adapter construct 时发生**；process 跑起来之后文件变化不会触发 re-index（12b 加 watcher / debounce）
4. **`.cursor/rules/memory.mdc`**：扩展名 `.mdc` 非 `.md`（宿主侧原生格式），parser 按 markdown_frontmatter 处理；未来若宿主改 `.md` 扩展，需同步更新 HOST_MEMORY_FILE_PATH_SPECS
5. **~/.claude/projects/*/memory/*.md glob**：可能匹配大量小文件；本批次不加 file count cap，依赖用户环境合理（12b 若需加 cap 再引入）
6. **Ranker floor = 0.05**：凭 Wave 3 直觉经验值，未经生产数据调校；12b 或后续 sunset 观察再调（GitHub #44 告警 wiring 也相关）
7. **SQLite-only**（继承 11a-11c 约束）；Postgres path 不初始化 FTS5 表，adapter `enabled = false`

## Review checklist
- 3 新文件 + 1 adapter 重写，其他 source/ 文件零改动？
- FTS5 migration 是 additive（IF NOT EXISTS）且 call 两入口？
- homeDir 是否真通过构造函数注入，测试用 `mkdtempSync`？
- profiles.ts 4 个 profile 都 append host_memory_file 到 default_sources？
- Ranker floor 是否只影响 host_memory_file records 的 score floor，不触其他源？
- 3 个 breaking test 文件是否**只**改假定数据 (enabled / default_sources / budget) 不动其他 assertion？
- 新测试是否真覆盖 sparse re-index + 文件删除 cleanup？
- homedir() top-level call 零？
- Known limitations 7 条原样落 commit body？

## Commit discipline
- 单 atomic commit，新起，不 amend `c34c802`
- 前缀 `feat(retrieval):`
- body 按 Acceptance #12（含 Known limitations 7 条）
- 不创建 markdown / root-level 文档
