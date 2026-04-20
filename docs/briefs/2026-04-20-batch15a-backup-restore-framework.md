# Batch 15a — Backup/restore evidence-chain framework (P8-036.1-.6 closure)

## Context

P8-036 (Wave 5) ships the backup/restore evidence chain. Design defaults approved:
- **Trigger**: manual CLI + MCP tools + self-managed daily scheduler (env-controlled interval).
- **Storage**: local filesystem only (`~/.vega/backups/<timestamp>/`). Remote (S3/etc.) deferred.
- **Integrity**: `sha256` per file + manifest sha256 over `files[]` → stored in same `manifest.json`. Recompute and verify on `restore_drill`.
- **Restore modes**: full + selective (by file path). Defaults to full.
- **Audit log**: SQLite `restore_audit` table (inline DDL pattern like alert_history) — operator / backup_id / mode / before-after hash / timestamp.
- **Drill**: `backup.restore_drill` MCP tool — dry-run manifest verification without writing.

All 6 subs in this single batch.

## Scope

### 1. `docs/backups/backup-config.yaml` (new) — starter config

```yaml
# Vega backup targets + retention policy (P8-036).
#
# Schema (zod-enforced in src/backup/registry.ts):
#   - targets: [string, ...]      # absolute paths OR ${VAR} / ${HOME} placeholders
#   - retention:
#       max_count: integer > 0    # keep last N backups; older pruned
#       min_days: integer >= 0    # never prune backups younger than N days
#   - exclude_globs: [string]     # optional glob patterns to skip inside target dirs
#   - scheduler:
#       enabled: boolean          # default true
#       interval_ms: integer > 0  # default 24*3600*1000 (daily)
#
targets:
  - "${HOME}/.vega/data/vega.db"
retention:
  max_count: 7
  min_days: 1
exclude_globs: []
scheduler:
  enabled: true
  interval_ms: 86400000
```

### 2. `src/backup/registry.ts` (new)

- zod `BackupConfigSchema` with `max_count > 0`, `min_days >= 0`, `interval_ms > 0`.
- `loadBackupConfig(path: string, { env? }): BackupConfig` — read YAML, expand `${VAR}` placeholders from `env ?? process.env`, zod-parse. On file missing / parse error → sensible defaults with warn log (never throws).
- Default config when registry missing: `{ targets: [], retention: { max_count: 7, min_days: 1 }, scheduler: { enabled: false, interval_ms: 86400000 } }` — absent targets means scheduler is effectively inert.

### 3. `src/backup/manifest.ts` (new)

- `BackupManifest` shape:
  ```ts
  {
    schema_version: "1.0";
    backup_id: string;          // timestamp-based, e.g. "2026-04-20T12-34-56Z"
    created_at: string;          // ISO
    created_by: string;          // "vega-backup"
    files: [
      { relative_path: string; size: number; sha256: string }
    ];
    manifest_sha256: string;     // sha256(JSON.stringify(files))
  }
  ```
- `buildManifest({ files, backup_id, now }): BackupManifest` — computes `manifest_sha256` over `JSON.stringify(files)` (NOT including `manifest_sha256` itself to avoid circularity).
- `verifyManifest(manifest, { readFile, expectedBasePath }): { ok: boolean; mismatches: string[] }` — recomputes per-file sha256 + the manifest sha256; returns list of mismatched `relative_path` OR "manifest_sha256" if top-level hash doesn't match.

### 4. `src/backup/trigger.ts` (new)

- `createBackup({ config, homeDir, now, fs?, logger? }): Promise<{ backup_id, path, file_count, total_bytes, manifest_sha256 }>`:
  - Resolve backup root: `${homeDir}/.vega/backups/<backup_id>/`. Create dir (mkdirp).
  - For each target: expand `${VAR}`, read file, copy to backup dir as `<relative_path>` (flattened: use basename; collisions handled by prefixing parent-dir hash).
  - Compute sha256 of each copied file.
  - Write `manifest.json` with computed manifest_sha256.
  - Run `applyBackupRetention(...)` — drop backups older than `min_days` AND keep at most `max_count`.
  - `homeDir` injected via options (no top-level `os.homedir()`).
  - On any IO error: log + return partial result with `degraded: true` field (never throws).
- `applyBackupRetention({ backupsRoot, retention, now, fs? }): { pruned_count }` — enumerate sibling backup dirs, sort by timestamp, keep top `max_count` if they're older than `min_days`.

### 5. `src/backup/restore.ts` (new)

- `restoreBackup({ backup_id, mode, selective?, homeDir, fs?, dryRun }): Promise<{ restored_at, files_restored, verified, mismatches: string[], degraded?: string }>`:
  - Load manifest from `${homeDir}/.vega/backups/<backup_id>/manifest.json`.
  - Run `verifyManifest(...)`. If mismatches → return `{ verified: false, mismatches }` without writing.
  - If `mode === "full"`: copy all files back to original location.
  - If `mode === "selective"` + `selective.files`: restrict to listed relative_paths.
  - If `dryRun === true`: verify only, do NOT copy.
  - Compute pre-restore sha256 for target files; record in audit.
- `runRestoreDrill({ backup_id, homeDir, fs? }): Promise<{ verified: boolean, mismatches: string[] }>` — wraps `restoreBackup({ dryRun: true })`.

### 6. `src/backup/audit.ts` (new)

SQLite `restore_audit` table (inline DDL):
```sql
CREATE TABLE IF NOT EXISTS restore_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  backup_id TEXT NOT NULL,
  mode TEXT NOT NULL,                -- 'full' | 'selective' | 'drill'
  operator TEXT NOT NULL,             -- user or 'system'
  before_state_sha256 TEXT,           -- hash of target files before restore
  after_state_sha256 TEXT,            -- hash of target files after restore
  restored_at INTEGER NOT NULL,       -- epoch ms
  verified INTEGER NOT NULL,          -- 0/1 boolean
  mismatches_json TEXT NOT NULL       -- JSON array of mismatch relative_paths
);
CREATE INDEX IF NOT EXISTS idx_restore_audit_backup ON restore_audit(backup_id, restored_at);
```

- `applyRestoreAuditMigration(db): void` — first statement `if (db.isPostgres) return;` (12a.1 pattern).
- `recordRestoreAudit(db, record): void` — insert row. Postgres-safe no-op.
- `listRestoreAudit(db, { limit }): AuditRow[]` — read rows, newest first.

### 7. `src/backup/scheduler.ts` (new)

Class `BackupScheduler` — self-managed lifecycle:
- Constructor: `{ config, homeDir, db, trigger, intervalMs, now }`
- `intervalMs` default from `config.scheduler.interval_ms`. Env override `VEGA_BACKUP_INTERVAL_MS` with `parsed > 0` guard.
- `start()` — if `config.scheduler.enabled === true` AND `config.targets.length > 0`, start timer; timer `unref()`-ed. Env gate `VEGA_BACKUP_SCHEDULER_ENABLED !== "false"`.
- `stop()` — idempotent `clearInterval`.
- `tick()` — call `createBackup(...)`; on error log + swallow (never throws from tick).

### 8. `src/backup/index.ts` (new, barrel)

Re-export all factories + types.

### 9. `src/mcp/server.ts` — 3 new tools

- **`backup.create`**: zod input `{ label?: string, targets?: string[] }`. Handler: invoke `createBackup(...)` (label optional tag); return `{ schema_version: "1.0", backup_id, path, file_count, total_bytes, manifest_sha256, degraded? }`. Never throws.
- **`backup.restore`**: zod input `{ backup_id: string, mode: "full" | "selective", selective?: { files: string[] }, dry_run?: boolean, operator?: string }`. Handler: `restoreBackup(...)` + `recordRestoreAudit(...)`. Returns `{ schema_version, restored_at, files_restored, verified, mismatches, degraded? }`.
- **`backup.restore_drill`**: zod input `{ backup_id: string }`. Handler: `runRestoreDrill(...)`; returns `{ schema_version, verified, mismatches }`.

All 3 never throw — degraded paths: `backup_missing`, `manifest_parse_error`, `file_read_error`.

### 10. Lifecycle wiring — `src/api/server.ts` + `src/mcp/server.ts`

Instantiate `BackupScheduler` alongside existing adapters. Env gate `VEGA_BACKUP_SCHEDULER_ENABLED !== "false"` (default enabled). Call `stop()` on shutdown. Match 12b / 13a / 14a pattern.

### 11. `docs/runbooks/backup-restore.md` (new)

Required sections (grep-checkable headings):
1. `## Backup triggers` — manual CLI / MCP / scheduler.
2. `## Manifest format + integrity chain` — sha256 per file + manifest_sha256 over files[].
3. `## Restore procedure (full + selective)` — step-by-step for both modes.
4. `## Restore drill` — use `backup.restore_drill` MCP tool before real restore to confirm manifest integrity.
5. `## Audit log` — query `restore_audit` table; retention.

### 12. Tests (5 new files, ≥ 20 cases total; no existing test touched)

- **`src/tests/backup-manifest.test.ts`** — ≥ 4 cases: happy build (3-file manifest) / verify happy / verify per-file mismatch / verify manifest_sha256 mismatch.
- **`src/tests/backup-trigger.test.ts`** — ≥ 4 cases: createBackup happy / retention prunes correctly respecting min_days / empty targets → inert / IO error → degraded without throw.
- **`src/tests/backup-restore.test.ts`** — ≥ 4 cases: full restore happy / selective restore (only listed files touched) / dryRun → no writes / mismatched manifest → verified:false no write.
- **`src/tests/backup-audit.test.ts`** — ≥ 3 cases: insert audit / list newest-first / Postgres-stub no-op.
- **`src/tests/backup-scheduler.test.ts`** — ≥ 3 cases: scheduler disabled config → no tick / happy tick calls trigger / stop() idempotent.

All tests hermetic: `mkdtempSync` tmp home dir, `:memory:` SQLite, inject fs fakes where needed. NO real file writes outside tmp.

## Out of scope — do NOT touch

- All prior byte-locked dirs (10a-14a stack).
- `src/scheduler/**`, `src/notify/**`, `src/sunset/**`, `src/alert/**`, `src/retrieval/**`, `src/reconciliation/**`.
- `src/monitoring/vega-metrics.ts` / `metrics-fingerprint.ts` / `metrics.ts` / `dashboards/**`.
- `src/db/migrations/**` / `src/core/contracts/**`.
- All existing `src/tests/*.test.ts` (only 5 new `backup-*.test.ts` files allowed).

## Forbidden patterns (Wave 5 全程继续)

- Production 代码不得嗅探测试环境
- 测试不得触碰真实 HOME（必须 `mkdtempSync`），不得写真实 `~/.vega/`
- 不 amend 09261ba / ea216e4；新起 commit
- Scheduler 用 `setInterval`（禁 fs.watch / chokidar / fsevents）
- `createBackup` / `restoreBackup` / `runRestoreDrill` 永不抛；错误 logger + return partial
- Manifest self-hash 计算时必须排除 `manifest_sha256` 字段（避免循环）
- `homeDir` 必须通过参数注入（禁 top-level `os.homedir()` 在 src/backup/**）

## Acceptance criteria

1. `docs/backups/backup-config.yaml` 存在；grep `^targets:` ≥ 1
2. 7 新 src/backup 文件：`registry.ts` / `manifest.ts` / `trigger.ts` / `restore.ts` / `audit.ts` / `scheduler.ts` / `index.ts`
3. `rg -nE 'setInterval' src/backup/scheduler.ts` ≥ 1；`rg -nE 'fs\.watch|chokidar|fsevents' src/backup/` 零命中
4. `rg -nE 'parsed\s*>\s*0' src/backup/scheduler.ts` ≥ 1（env guard）
5. `rg -nE 'if\s*\(\s*db\.isPostgres\s*\)' src/backup/audit.ts` ≥ 1（第一句，12a.1 pattern）
6. `rg -n 'homedir\s*\(' src/backup/` **零**命中（homeDir 必走参数注入）
7. `rg -nE 'backup\.(create|restore|restore_drill)' src/mcp/server.ts` ≥ 3
8. `docs/runbooks/backup-restore.md` 存在，5 个 section heading 各 ≥ 1
9. 5 个新 `backup-*.test.ts` 文件各存在，test case 总 ≥ 18 (4+4+4+3+3)
10. `git diff HEAD --name-only -- src/` 仅涉及 `src/backup/**` + `src/mcp/server.ts` + 可选 `src/api/server.ts` + 5 个新 test 文件
11. `git diff HEAD -- src/scheduler/ src/notify/ src/sunset/ src/alert/ src/retrieval/ src/reconciliation/ src/monitoring/vega-metrics.ts src/monitoring/metrics-fingerprint.ts src/monitoring/metrics.ts dashboards/ src/db/migrations/ src/core/contracts/` 输出为空
12. `git diff HEAD -- src/tests/` 仅显示 5 个新 `backup-*.test.ts`；其他 test 文件零变动
13. `set -o pipefail; npm run build` 成功；`set -o pipefail; npm test` 全绿（预期 ≥ 1123 pass，含 18 新 tests）
14. 严格**不 amend** 09261ba / ea216e4；新起 commit
15. Commit title 前缀 `feat(backup):`
16. Commit body:
    ```
    Ships the backup/restore evidence-chain framework P8-036.1-.6:
    - docs/backups/backup-config.yaml (starter with ${HOME}-expanded SQLite
      target + 7-day retention + daily scheduler).
    - src/backup/{registry,manifest,trigger,restore,audit,scheduler,index}.ts:
      zod-validated config, per-file sha256 + manifest_sha256 chain
      (excluded from its own hash input), createBackup with retention pruning
      honoring min_days floor, full + selective restore with pre-flight
      manifest verification, runRestoreDrill dry-run without writes, SQLite
      restore_audit table (inline DDL + Postgres self-guard), self-managed
      setInterval scheduler (daily default, VEGA_BACKUP_INTERVAL_MS env with
      parsed > 0), dispose()-style stop().
    - 3 new MCP tools: backup.create / backup.restore / backup.restore_drill.
      All never throw; degraded paths: backup_missing / manifest_parse_error
      / file_read_error.
    - Lifecycle wiring mirrors 12b/13a/14a (VEGA_BACKUP_SCHEDULER_ENABLED env
      gate, dispose on shutdown).
    - docs/runbooks/backup-restore.md: triggers / manifest integrity chain /
      restore procedure (full + selective) / restore drill / audit log.
    - 5 new backup-*.test.ts files with ≥ 18 hermetic cases (mkdtempSync tmp
      home, :memory: SQLite, no real file writes outside tmp).

    Scheduler self-managed in src/backup/; zero touches to src/scheduler/.
    Audit table uses inline DDL — no new migration file. homeDir injected
    via constructor (no top-level os.homedir() in src/backup/**).

    Scope-risk: low
    Reversibility: clean (disable via VEGA_BACKUP_SCHEDULER_ENABLED=false;
    manual MCP tools remain usable regardless)
    ```

## Review checklist

- Manifest self-hash 是否排除 `manifest_sha256` 字段？（hash input = JSON.stringify(files) only）
- Retention 是否同时遵守 `min_days` floor 与 `max_count` ceiling？（min_days-young backups 不被 prune）
- Scheduler 是否在 `config.targets.length === 0` 时不启动？
- 3 个新 MCP tool 是否都 never-throw + degraded 分支？
- `homeDir` 是否通过构造参数注入到 backup/trigger/restore/scheduler？（grep `homedir\s*\(` 空）
- 5 个 test 是否全 hermetic（mkdtempSync + :memory: + mock fs 时）？
- `src/scheduler/**` / `src/alert/**` / `src/sunset/**` 是否零变动？
- 新 commit 叠 `ea216e4` 下方，不 amend？

## Commit discipline

- 单 atomic commit，新起
- 前缀 `feat(backup):`
- body 按 Acceptance #16
- 不创建 root-level markdown / 其他 docs 除 `docs/backups/backup-config.yaml` + `docs/runbooks/backup-restore.md`
