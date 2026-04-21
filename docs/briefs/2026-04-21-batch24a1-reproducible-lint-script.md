# Batch 24a.1 — Make readonly-guard lint reproducible (resolves B3 SEAL block)

## Context

B3 review (`cd96831`) was BLOCKED because Acceptance #8's literal command (`npx eslint src/retrieval/sources/host-memory-file*.ts --no-eslintrc --config .eslintrc.cjs`) fails on repo's default ESLint v10.2.1 — the `--no-eslintrc` flag was removed in v9+ (flat-config era). The actual working command uses pinned v8.57.0 + explicit `--parser` path, which is not reproducible for future devs.

Fix: encapsulate the working invocation as a repo npm script so the guard is one `npm run ...` away and stays reproducible across environments. Small add-on; no scope creep.

Also add one missing crafted test case (`fsp.writeFile(...)` alias case) that the original 24a static scanner technically covers via regex but had no explicit assertion for.

No amend of `cd96831` — new commit on HEAD.

## Scope

### 1. `package.json` — add script `lint:readonly-guard`

```json
"scripts": {
  ...existing...,
  "lint:readonly-guard": "npx -y -p eslint@8.57.0 -p @typescript-eslint/parser@7.18.0 eslint src/retrieval/sources/host-memory-file.ts src/retrieval/sources/host-memory-file-fts.ts src/retrieval/sources/host-memory-file-paths.ts src/retrieval/sources/host-memory-file-parser.ts --no-eslintrc --config .eslintrc.cjs --resolve-plugins-relative-to node_modules --parser @typescript-eslint/parser"
}
```

- MUST use pinned `eslint@8.57.0` via `npx -p` so future eslint upgrades don't silently break the readonly guard.
- MUST use pinned `@typescript-eslint/parser@7.18.0` (compatible with eslint 8).
- MUST target the 4 protected files explicitly (not glob).
- Exit 0 = guard passing; exit 1+ = violation.

If the pinned-parser path pattern differs from what actually works in codex's env (codex should verify empirically), adjust to the minimal form that works. The non-negotiable: running this single script reproduces the guard pass.

### 2. Verify script works

Run `npm run lint:readonly-guard` and confirm exit 0.

### 3. `src/tests/host-memory-file-readonly-guard.test.ts` — add explicit `fsp` alias case

The static scanner covers `fsp.writeFile(...)` via regex `\\b(?:\\w+\\.)*writeFile\\s*\\(`, but only `fs.promises.writeFile(...)` had an explicit crafted mock in B3. Add one more test:

```ts
test("readonly scanner flags fsp alias for fs.promises write calls", () => {
  const craftedSource = `
    import { promises as fsp } from 'node:fs';
    async function leak() {
      await fsp.writeFile('/tmp/x', 'y');
    }
  `;
  const violations = collectReadOnlyGuardViolations(craftedSource, 'fake.ts');
  assert.ok(violations.length >= 1, `expected at least 1 violation, got ${violations.length}`);
  assert.ok(violations.some(v => /writeFile/.test(v.evidence)), 'expected writeFile in violation evidence');
});
```

Name + shape are illustrative — codex picks based on actual `collectReadOnlyGuardViolations` signature in the existing test file.

### 4. Update brief 24a doc to note the tradeoff (closure appendix)

Append a "Resolution appendix" to `docs/briefs/2026-04-21-batch24a-audit-medium-fixes.md`:

```md
## Resolution appendix (2026-04-21, post-24a.1)

### Acceptance #1 tradeoff
B3 chose to lock the current 0/6 store-support state as a binding assertion rather than
enforce `>= 4` directly on the main test, because no store schema currently backs
`source_kind`. The `>= 4` invariant lives in a pure helper `assertStoreSupportThreshold`
with an isolated regression test. When B6 (P8-029 schema migration) lands and support
reaches ≥ 4, the main-test assertion will be switched to `>= 4` at that time.

### Acceptance #8 reproducibility
The brief's literal `npx eslint ... --no-eslintrc` command does not work on ESLint v10+
(the `--no-eslintrc` flag was removed). The reproducible entry point is now
`npm run lint:readonly-guard` (B3 24a.1 follow-up), which pins `eslint@8.57.0` +
`@typescript-eslint/parser@7.18.0` via npx.

### Acceptance #14 commit body
`cd96831`'s commit body lost some backtick escaping via the shell HEREDOC; intent and
scope are preserved. Not re-amended — cosmetic.
```

## Out of scope — do NOT touch

- `src/backup/**` (B2 sealed)
- Everything outside: `package.json` + `src/tests/host-memory-file-readonly-guard.test.ts` + `docs/briefs/2026-04-21-batch24a-audit-medium-fixes.md`
- No new source files
- No ESLint upgrade (pinning v8 via npx is the fix)
- `.eslintrc.cjs` — already correct, don't touch

## Forbidden patterns

- NO amend of `cd96831` — new commit on HEAD
- NO ESLint v9/v10 flat-config migration (out of scope; large change)
- Pinned versions (`eslint@8.57.0` + `@typescript-eslint/parser@7.18.0`) MUST be explicit in script
- `fsp` test must actually assert violation count ≥ 1 (not just log)

## Acceptance criteria

1. `rg -n "lint:readonly-guard" package.json` ≥ 1
2. `rg -n "eslint@8.57.0" package.json` ≥ 1 (pinned)
3. `rg -n "@typescript-eslint/parser@" package.json` ≥ 1 (pinned)
4. `npm run lint:readonly-guard` exits 0
5. `rg -c "^test\\(" src/tests/host-memory-file-readonly-guard.test.ts` ≥ previous count + 1
6. `rg -n "fsp\\." src/tests/host-memory-file-readonly-guard.test.ts` ≥ 1 (explicit fsp case)
7. `docs/briefs/2026-04-21-batch24a-audit-medium-fixes.md` contains `## Resolution appendix`
8. `git diff HEAD -- src/retrieval/ src/backup/ src/reconciliation/ src/monitoring/ src/scheduler/ src/notify/ src/sunset/ src/alert/ src/timeout/ src/checkpoint/ src/feature-flags/ src/sdk/ src/api/ src/mcp/ src/db/migrations/ src/core/contracts/ .eslintrc.cjs` empty
9. `git diff HEAD --name-only` ⊆ `{package.json, src/tests/host-memory-file-readonly-guard.test.ts, docs/briefs/2026-04-21-batch24a-audit-medium-fixes.md}` (maybe +package-lock.json if npx cache updates it)
10. `set -o pipefail; npm run build` exits 0; `set -o pipefail; npm test` ≥ 1201 pass / 0 fail (1200 + 1 new fsp case)
11. Not-amend; parent of new commit = `cd96831`
12. Commit title prefix `chore(lint):`
13. Commit body:
    ```
    Add reproducible npm run lint:readonly-guard entrypoint + close B3 review gaps.

    - package.json: new lint:readonly-guard script pinning eslint@8.57.0 +
      @typescript-eslint/parser@7.18.0 via npx, targeting the 4 protected
      host-memory-file sources. Single command reproduces the guard pass.
    - src/tests/host-memory-file-readonly-guard.test.ts: explicit crafted
      test for fsp alias (import { promises as fsp } from 'node:fs') since
      24a only covered fs.promises.writeFile explicitly; scanner regex
      always covered this, now there's an assertion too.
    - docs/briefs/2026-04-21-batch24a-audit-medium-fixes.md: resolution
      appendix documenting the B3 tradeoffs (store-support threshold
      locked to 0/6 current + >= 4 invariant kept in helper; eslint
      v10 --no-eslintrc incompatibility resolved via pinned v8 script;
      cosmetic commit-body escape not re-amended).

    Scope: 3 files only. Zero source-code or contract touches.

    Scope-risk: minimal
    Reversibility: clean
    ```

## Review checklist

- Does `npm run lint:readonly-guard` actually exit 0 (not rely on network npx cache)?
- Are pinned versions exact (`@8.57.0` + `@7.18.0`), not ranges?
- Is the fsp test asserting violation count ≥ 1, not just logging?
- Resolution appendix accurately reflects the 3 deviation points (#1 tradeoff / #8 toolchain / #14 cosmetic)?
- Scope limited to package.json + 1 test + 1 doc?
- New commit stacks on `cd96831` (not amend)?

## Commit discipline

- Single atomic commit, new stack on HEAD
- Prefix `chore(lint):`
- Body per Acceptance #13
- Files changed: `package.json` + `src/tests/host-memory-file-readonly-guard.test.ts` + `docs/briefs/2026-04-21-batch24a-audit-medium-fixes.md` (+ maybe `package-lock.json` if npx cache touches it — OK if so)
