# Batch 12a.1 — Close Round-1 findings on 93bdd09 (FTS Postgres guard + truncate off-by-one)

## Context

Round-1 review on commit `93bdd09` (Batch 12a — HostMemoryFileAdapter core) returned **BLOCK** with:

- **HIGH #3** — `src/retrieval/sources/host-memory-file-fts.ts:32`. `applyHostMemoryFileFtsMigration()` runs FTS DDL unconditionally. Callers guard at `src/api/server.ts` + `src/mcp/server.ts`, but the helper itself has no Postgres early-return. Design contract: SQLite-only FTS migration. Fix: add `if (db.isPostgres) return;` at the top.
- **HIGH #8** — `src/scheduler/index.ts:2,130` touched. Brief marked `src/scheduler/**` forbidden. **Resolution: accept the change as necessary plumbing**. Scheduler is a runtime entrypoint that instantiates the API server, which must receive homeDir to pass into HostMemoryFileAdapter. The 12a brief's forbidden-scheduler clause was over-restrictive; this batch formally carves out `src/scheduler/index.ts` (plumbing-only) as **allowed**.
- **LOW #12** — `src/retrieval/sources/host-memory-file.ts:48-49`. `truncateContent()` slices `MAX_CONTENT_CHARS` (4096) chars and then appends `…`, giving 4097 char content — violates the `<=4096` contract. Fix: slice to `MAX_CONTENT_CHARS - 1` before appending, so `…` lands at position 4096 exactly.

Build + full test suite green (1048 tests) on 93bdd09; no functional regression.

## Scope

### 1. `src/retrieval/sources/host-memory-file-fts.ts` — Postgres guard
Add `if (db.isPostgres) return;` as the first statement inside `applyHostMemoryFileFtsMigration()` body (before the DDL). Preserve the existing caller-side guards in `src/api/server.ts` + `src/mcp/server.ts` (defence-in-depth; callers don't need to change).

### 2. `src/retrieval/sources/host-memory-file.ts` — truncate off-by-one
In `truncateContent()` (around line 48-49), change the slice length from `MAX_CONTENT_CHARS` to `MAX_CONTENT_CHARS - 1`:
```ts
content.length > MAX_CONTENT_CHARS ? `${content.slice(0, MAX_CONTENT_CHARS - 1)}…` : content;
```
Result: final string length ≤ `MAX_CONTENT_CHARS` (4096) exactly, ellipsis included.

### 3. `src/tests/host-memory-file-adapter.test.ts` — 2 new test cases
Add (keep existing 6 untouched):

- **Postgres guard**: construct a stub `DatabaseAdapter` with `isPostgres: true` whose `exec()` / `prepare()` methods throw if called. Call `applyHostMemoryFileFtsMigration(stubDb)` — must return without throwing and without invoking `exec`/`prepare`. Prove the internal early-return is wired.
- **Truncate boundary**: call the adapter on a synthetic host file whose parsed content is exactly 10000 chars. Assert the resulting `SourceRecord.content.length === MAX_CONTENT_CHARS` (4096), last char is `…`.

If isolating `truncateContent` without exporting it is awkward, assert via end-to-end: write a long file to tmp home, let adapter index, search, check `records[0].content.length <= 4096 && records[0].content.endsWith('…')`.

### 4. Scheduler scope carve-out
**Do NOT change `src/scheduler/index.ts`**. It already holds the correct plumbing change from 93bdd09 (import `homedir` + pass `{ homeDir: process.env.HOME ?? homedir() }` to `createAPIServer`). Leave byte-identical.

The 12a.1 commit body must formally document:
> 12a brief's `src/scheduler/**` forbidden-file clause was over-restrictive. Scheduler as a runtime entrypoint must forward homeDir into the API server so HostMemoryFileAdapter receives a real home directory in scheduler-launched runtime. From 12a.1 onward, `src/scheduler/index.ts` is allowed for plumbing-only changes (constructor-passing, config-forwarding); all other scheduler files remain forbidden.

## Out of scope — do NOT touch

- `src/reconciliation/**` (byte-locked since 11a)
- `src/monitoring/vega-metrics.ts` / `src/monitoring/metrics-fingerprint.ts` (byte-locked since 10b.1)
- `dashboards/**`
- `src/scheduler/**` except `src/scheduler/index.ts` (carve-out above)
- `src/notify/**` / `src/db/migrations/**` / `src/core/contracts/**`
- `src/api/server.ts` / `src/mcp/server.ts` (already correctly guarding FTS migration at call sites; no change needed — the helper's new internal guard is defence-in-depth)
- 10a.1 revert-locked files
- `src/retrieval/sources/host-memory-file-paths.ts` / `host-memory-file-parser.ts` (correct as-is)
- Any existing test file except `src/tests/host-memory-file-adapter.test.ts`

## Forbidden files

All prior batch Out-of-scope files (inherited). Specifically:
- All `src/reconciliation/**` files
- All `src/monitoring/vega-metrics.ts` / `metrics-fingerprint.ts` / `metrics.ts` / `dashboards/**`
- All `src/scheduler/**` files except `src/scheduler/index.ts` (but even `index.ts` must NOT change in 12a.1 — it's already correct from 93bdd09)
- All `src/notify/**` / `src/db/migrations/**` / `src/core/contracts/**`
- `src/api/server.ts` / `src/mcp/server.ts` (callers unchanged)
- `src/retrieval/ranker-score.ts` / `src/retrieval/profiles.ts` / `src/retrieval/orchestrator.ts` / `src/retrieval/orchestrator-config.ts` / `src/retrieval/sources/registry.ts` (all correct from 93bdd09)
- `src/retrieval/sources/host-memory-file-paths.ts` / `host-memory-file-parser.ts`
- `src/index.ts` / `src/api/mcp.ts`
- Existing tests (`retrieval-orchestrator-integration.test.ts` / `retrieval-profiles.test.ts` / `retrieval-budget.test.ts`) — already tight from 93bdd09
- `docs/**` except this brief
- Root-level markdown files

## Forbidden patterns (Wave 5 全程继续)

- Production 代码不得嗅探测试环境
- 测试不得触碰 macOS 真实钥匙串 / 真实 HOME / 真实 user config（Postgres-guard test 的 stub DatabaseAdapter 必须 fake，不实例化 real Postgres）
- 不 amend `93bdd09`，新起 commit 叠加

## Acceptance criteria

1. `grep -nE 'if\s*\(\s*db\.isPostgres\s*\)\s*return' src/retrieval/sources/host-memory-file-fts.ts` 至少 1 处命中（新加的内部 guard）
2. `grep -nE 'MAX_CONTENT_CHARS\s*-\s*1' src/retrieval/sources/host-memory-file.ts` 至少 1 处命中
3. `grep -nE 'slice\(\s*0\s*,\s*MAX_CONTENT_CHARS\s*\)' src/retrieval/sources/host-memory-file.ts` **零**命中（原 4096-full-slice 已替换）
4. `src/tests/host-memory-file-adapter.test.ts` 新增 ≥ 2 个 test case：Postgres guard + truncate boundary。`grep -c "^test(" src/tests/host-memory-file-adapter.test.ts` ≥ 8（原 6 + 新 2）
5. `git diff HEAD -- src/retrieval/sources/` 仅涉及 `host-memory-file-fts.ts` + `host-memory-file.ts`；`host-memory-file-paths.ts` / `host-memory-file-parser.ts` 零变动
6. `git diff HEAD -- src/tests/` 仅涉及 `host-memory-file-adapter.test.ts`；`retrieval-orchestrator-integration.test.ts` / `retrieval-profiles.test.ts` / `retrieval-budget.test.ts` 零变动（它们 93bdd09 已改对）
7. `git diff HEAD -- src/scheduler/` 输出为空（scheduler/index.ts 保持 93bdd09 状态不变）
8. `git diff HEAD -- src/api/server.ts src/mcp/server.ts src/index.ts src/api/mcp.ts src/retrieval/ranker-score.ts src/retrieval/profiles.ts src/retrieval/orchestrator.ts src/retrieval/orchestrator-config.ts src/retrieval/sources/registry.ts` 输出为空
9. `git diff HEAD -- src/reconciliation/ src/monitoring/ dashboards/ src/scheduler/ src/notify/ src/db/migrations/ src/core/contracts/` 全部为空
10. `npm run build` 成功退出；`npm test` 全绿（预期 ≥ 1050 pass，因 ≥ 2 条新测试）。`set -o pipefail` 使用
11. 严格**不 amend** commit `93bdd09`，新起 commit 在其上
12. Commit title 前缀 `fix(retrieval):`
13. Commit body（必须包含 scheduler 豁免说明）：
    ```
    Closes Round-1 review on 93bdd09 (Batch 12a HostMemoryFileAdapter core).
    Fixes two blockers and one low-severity finding:

    - HIGH #3: applyHostMemoryFileFtsMigration() lacked its own Postgres
      guard. Callers in src/api/server.ts and src/mcp/server.ts already
      skipped it on Postgres, but defence-in-depth requires the helper to
      short-circuit itself. Added `if (db.isPostgres) return;` at the top.

    - LOW #12: truncateContent() sliced MAX_CONTENT_CHARS chars then
      appended '…', producing 4097-char output and violating the ≤4096
      contract. Changed slice length to MAX_CONTENT_CHARS - 1 so the
      ellipsis lands at position 4096 exactly.

    Test additions in host-memory-file-adapter.test.ts (2 new cases):
    Postgres-guard stub verifying zero DDL execution under isPostgres=true;
    10000-char fixture asserting SourceRecord.content.length === 4096 and
    trailing '…'.

    Scheduler scope carve-out: the 12a brief's `src/scheduler/**` forbidden
    clause was over-restrictive. Scheduler is a runtime entrypoint that
    must forward homeDir into the API server so HostMemoryFileAdapter
    receives a real home directory in scheduler-launched runtime. From
    12a.1 onward, `src/scheduler/index.ts` is allowed for plumbing-only
    changes (constructor-passing, config-forwarding); all other scheduler
    files remain forbidden. The existing homeDir plumbing in 93bdd09 is
    preserved unchanged.

    HIGH #8 resolution: no code change; scope amendment documented above.

    Scope-risk: none
    Reversibility: clean
    ```

## Review checklist

- `applyHostMemoryFileFtsMigration()` 的新 guard 是否在函数体最顶？（不是 helper 后某 branch 内）
- `truncateContent()` 的 slice 长度是否 `MAX_CONTENT_CHARS - 1`？（不是还在 `MAX_CONTENT_CHARS`）
- 新加 Postgres-guard test 是否用 stub adapter（不实例化 real Postgres）？
- 新加 truncate test 是否断言 `length === MAX_CONTENT_CHARS` + `endsWith('…')`？（不是 `<=`）
- `src/scheduler/index.ts` 是否 byte-identical 于 93bdd09？（`git diff 93bdd09 HEAD -- src/scheduler/index.ts` 空）
- 是否零 touch 其他文件？（grep 1-9 全过）
- 新 commit 是否叠 `93bdd09` 下方，不 amend？

## Commit discipline

- 单 atomic commit，新起
- 前缀 `fix(retrieval):`
- body 按 Acceptance #13
- 不创建 markdown / root-level 文档 (本 brief 已在 docs/briefs/)
