# Batch 23a — Harden restoreBackup against path traversal (closes #50)

## Context

Phase 8 audit issue #50 (severity-HIGH). `src/backup/restore.ts` trusts `manifest.files[*].relative_path` without validating containment. A crafted manifest entry like `restore-target/../../payload.txt` escapes the restore root and writes anywhere on disk. `verifyManifest()` in `src/backup/manifest.ts:65` reads outside the backup directory via the same untrusted path. Fix both sides.

Backup framework shipped in batch 15a (`e48c9d9`). Do NOT amend 15a — new commit on HEAD.

## Scope

### 1. `src/backup/restore.ts` — reject traversal at all 4 call sites (lines 122 / 138 / 198 / 226)

Add a helper (export or private) `assertSafeRelativePath(relative_path: string, base: string): string`:
- `normalize(relative_path)` first
- Reject if `path.isAbsolute(normalized)` → throw `BackupIntegrityError` with code `UNSAFE_ABSOLUTE_PATH`
- Reject if normalized starts with `..` or contains a `/..` segment → throw with code `UNSAFE_TRAVERSAL_SEGMENT`
- Reject if normalized contains null bytes → throw with code `UNSAFE_NULL_BYTE`
- Compute `resolved = path.resolve(base, normalized)` and require `resolved === base || resolved.startsWith(base + path.sep)` → else throw with code `UNSAFE_OUTSIDE_BASE`
- Return `normalized` on success

Call it before **every** `join(base, file.relative_path)` in restore.ts (the 4 locations) AND in manifest.ts:65 before the verify read.

### 2. `src/backup/manifest.ts:65` — apply same guard to verifyManifest read path

Same helper or duplicated inline (prefer shared export). `verifyManifest` reading `join(expectedBasePath, file.relative_path)` must be rejected if the path escapes `expectedBasePath`.

### 3. Structured error shape

`BackupIntegrityError` (existing or new in `src/backup/manifest.ts`) gets a `code` field ∈ `"UNSAFE_ABSOLUTE_PATH" | "UNSAFE_TRAVERSAL_SEGMENT" | "UNSAFE_NULL_BYTE" | "UNSAFE_OUTSIDE_BASE" | ...existing codes`. Downstream consumers (audit log, metrics) must see the reject reason.

### 4. `restoreBackup()` behavior on rejection

When any file entry fails the guard:
- Do NOT write ANY file from the manifest (fail-closed — not partial restore).
- Return `{ verified: false, files_restored: 0, error: { code, path, message } }`.
- Emit audit entry with `status: "rejected"` and the error code.
- Log WARN with manifest id + violating entry path (truncate long paths to 200 chars).

### 5. Tests (new file) — `src/tests/backup-path-traversal.test.ts` ≥ 6 cases

Hermetic (mkdtempSync tmp dir + :memory: SQLite where needed):

- **Traversal via `../` in relative_path** → `restoreBackup` returns `verified: false`, zero writes outside target root, audit records `UNSAFE_TRAVERSAL_SEGMENT`. This is the exact PoC from issue body.
- **Absolute path in relative_path** (e.g. `/etc/passwd`) → rejected with `UNSAFE_ABSOLUTE_PATH`.
- **Null byte in relative_path** → rejected with `UNSAFE_NULL_BYTE`.
- **verifyManifest with traversal** → returns `verified: false` + error; does NOT read files outside backup dir (test by putting a sentinel file at `<backupPath>/../leak.txt` and asserting the verify call did not crash due to reading it).
- **Legitimate nested path** (e.g. `subdir/file.txt`) → restores successfully under target root.
- **Fail-closed invariant**: manifest with 2 safe entries + 1 traversal entry → NO file written (not even the 2 safe ones). Whole restore is atomic-rejected.

All hermetic — use `mkdtempSync` for backup dir + restore target dir; no real HOME.

## Out of scope — do NOT touch

- `src/backup/audit.ts` / `trigger.ts` / `scheduler.ts` / `registry.ts` (only restore.ts + manifest.ts need touching)
- `src/reconciliation/**`, `src/monitoring/**`, `src/scheduler/**`, `src/notify/**`, `src/sunset/**`, `src/alert/**`, `src/timeout/**`, `src/checkpoint/**`, `src/feature-flags/**`, `src/retrieval/**`, `src/api/**`, `src/mcp/**`, `src/db/migrations/**`, `src/core/contracts/**`
- `.eslintrc.cjs` (17a sealed)
- Any existing test except adding 1 new `backup-path-traversal.test.ts`

## Forbidden patterns

- Production code MUST NOT sniff test env
- Tests MUST NOT touch real HOME / keychain / user config
- NO amend of `e48c9d9` (15a) — new commit on HEAD
- Partial restore on rejection is FORBIDDEN (fail-closed is the contract)
- No skipping / TODO-ing any of the 6 tests

## Acceptance criteria

1. `rg -nE "assertSafeRelativePath|normalize" src/backup/restore.ts` ≥ 4 occurrences (4 call sites guarded)
2. `rg -nE "assertSafeRelativePath|normalize" src/backup/manifest.ts` ≥ 1 (verifyManifest read path guarded)
3. `rg -nE "UNSAFE_(TRAVERSAL|ABSOLUTE|OUTSIDE|NULL)" src/backup/` ≥ 4 distinct codes
4. `src/tests/backup-path-traversal.test.ts` exists; `rg -c "^test\\(" src/tests/backup-path-traversal.test.ts` ≥ 6
5. `git diff HEAD -- src/reconciliation/ src/monitoring/ src/scheduler/ src/notify/ src/sunset/ src/alert/ src/timeout/ src/checkpoint/ src/feature-flags/ src/retrieval/ src/api/ src/mcp/ src/db/migrations/ src/core/contracts/ .eslintrc.cjs` empty
6. `git diff HEAD -- src/backup/` limited to `restore.ts` + `manifest.ts`
7. `git diff HEAD -- src/tests/` shows only 1 new `backup-path-traversal.test.ts`
8. `set -o pipefail; npm run build` exits 0; `set -o pipefail; npm test` ≥ 1196 pass / 0 fail (1190 + 6 new)
9. Not-amend; new commit on HEAD
10. Commit title prefix `fix(backup):`
11. Commit body:
    ```
    Harden restoreBackup against path traversal (closes #50, severity HIGH).

    - src/backup/restore.ts: guard all 4 manifest path consumption sites
      with assertSafeRelativePath (normalize → absolute-reject → traversal-
      reject → null-byte-reject → containment check). Fail-closed: any
      invalid entry rejects the whole manifest, zero writes.
    - src/backup/manifest.ts: verifyManifest read path uses the same guard
      so crafted manifests cannot force reads outside expectedBasePath.
    - BackupIntegrityError extended with UNSAFE_ABSOLUTE_PATH /
      UNSAFE_TRAVERSAL_SEGMENT / UNSAFE_OUTSIDE_BASE / UNSAFE_NULL_BYTE
      codes; audit log + WARN emit the violating entry.
    - New backup-path-traversal.test.ts (≥ 6 hermetic cases) reproduces
      the PoC from issue #50, covers absolute + null-byte + containment
      rejections, and asserts fail-closed atomicity.

    Scope: only src/backup/restore.ts + manifest.ts + 1 new test file.
    Zero reconciliation / monitoring / scheduler / retrieval / api /
    mcp / migrations / contracts / eslint changes.

    Scope-risk: low (fail-closed guard; legitimate paths unaffected)
    Reversibility: clean
    ```

## Review checklist

- Guard normalizes FIRST then validates (not raw input)?
- Null byte rejected (not just `/\0/` regex — check `normalized.includes('\\0')`)?
- Containment check uses `base + path.sep` or `path.relative` to avoid prefix aliasing (e.g. `/home/userX` prefixing `/home/user`)?
- All 4 restore.ts call sites actually guarded (not just 1-2)?
- manifest.ts verifyManifest also guarded?
- Fail-closed atomicity tested (not just individual rejection)?
- PoC from issue body reproducible as a test?
- New commit stacks on HEAD (not amend 15a's `e48c9d9`)?

## Commit discipline

- Single atomic commit, new stack on HEAD
- Prefix `fix(backup):`
- Body per Acceptance #11
- Files changed: `src/backup/restore.ts` + `src/backup/manifest.ts` + 1 new `src/tests/backup-path-traversal.test.ts`
