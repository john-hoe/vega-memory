# Batch 24a — Fix audit medium findings: #51 source-kind test 假绿 + #52 ESLint alias bypass

## Context

Phase 8 audit issues #51 + #52 (both severity-MEDIUM). Two independent fixes, bundled because they touch non-overlapping test/lint surfaces.

**#51** — `src/tests/source-kind-propagation.test.ts:357-381` contains `assert.equal(supportingStores.length >= 0, true)` (tautology). Brief 19a required `>= 4` threshold. Currently the test stays green even with 0/6 stores supporting `source_kind`.

**#52** — `.eslintrc.cjs:12-20` ESLint rule only matches literal `writeFileSync` / `mkdirSync` / etc. on `CallExpression.callee.type='MemberExpression'`. Destructured/aliased imports bypass it:
```ts
import { writeFileSync as wf } from 'node:fs';
wf('/tmp/x', 'y');  // not flagged
```
Plus: `fs.promises` variants uncovered; `open(..., 'w'...)` uncovered; runtime source-scan test (`src/tests/host-memory-file-readonly-guard.test.ts:136-143`) regex is too narrow to catch aliased imports.

## Scope

### Part A — #51 source-kind test threshold

#### A1. `src/tests/source-kind-propagation.test.ts` — restore threshold

In Test B (or wherever `supportingStores` is accumulated, line ~357-381):
- Replace `assert.equal(supportingStores.length >= 0, true)` with `assert.ok(supportingStores.length >= 4, \`expected ≥ 4 stores to support source_kind, got \${supportingStores.length}: [\${supportingStores.join(",")}]; missing: [\${missingStores.join(",")}]\`)`.
- Log still lists missing stores (keep existing warn output) but assertion is now binding.

#### A2. `src/tests/source-kind-propagation.test.ts` — add negative regression test

New test "store-support threshold hard-fails below 4": stub `supportingStores` accumulation (or inject a helper to evaluate the threshold in isolation) and assert that `evaluateStoreSupport([])` / `evaluateStoreSupport(['candidate'])` throws or returns fail, while `evaluateStoreSupport(['candidate','memories','wiki','fact_claim'])` passes.

Preferred: extract a small pure helper `assertStoreSupportThreshold(supporting: string[], floor = 4): void` in the same test file (or a test util), then the negative regression calls it with a list < floor and expects it to throw, while the positive path calls it with ≥ floor and expects no throw.

#### A3. `docs/architecture/source-kind-propagation.md:29-39` — doc alignment

Update "Known gaps" section to reflect the current enforced invariant. If test now enforces `>= 4`, doc's "Known gaps" lists exactly the currently-missing stores (should match test's `missingStores` output). No new gap claims.

### Part B — #52 ESLint alias bypass + static scan

#### B1. `.eslintrc.cjs` — extend rule to cover aliased imports

The existing `no-restricted-syntax` override scoped to the 4 host-memory-file files (`src/retrieval/sources/host-memory-file*.ts` minus the adapter's indexing write path — whatever 17a protects) ADD:

1. **`no-restricted-imports`** with specific banned specifiers from `node:fs` / `fs` / `node:fs/promises` / `fs/promises`:
   - `writeFile`, `writeFileSync`, `appendFile`, `appendFileSync`, `mkdirSync`, `mkdir`, `rmSync`, `rm`, `unlinkSync`, `unlink`, `renameSync`, `rename`, `chmodSync`, `chmod`, `chownSync`, `chown`, `createWriteStream`, `open` (because of `open(path, 'w')` flag), `openSync`, `copyFile`, `copyFileSync`, `link`, `linkSync`, `symlink`, `symlinkSync`, `truncate`, `truncateSync`, `ftruncate`, `ftruncateSync`, `utimes`, `utimesSync`
   - Pattern: use `paths` array with `{name: 'node:fs', importNames: [...bannedList]}` × 4 modules
2. **`no-restricted-syntax`** keep the existing member-expression selector (for `fs.writeFileSync(...)` style) AND add:
   - Selector for `CallExpression[callee.type='Identifier'][callee.name=/^(writeFile|writeFileSync|appendFile|appendFileSync|mkdirSync|mkdir|rmSync|rm|unlinkSync|unlink|renameSync|rename|chmodSync|chmod|chownSync|chown|createWriteStream|openSync)$/]` — catches calls of aliased or directly-imported identifiers regardless of alias (any local name starting with these still gets caught via import side, but the syntax selector is a defense-in-depth)

Result: even `import { writeFileSync as wf } from 'node:fs'; wf(...)` fires at least the `no-restricted-imports` rule at the import line.

#### B2. `src/tests/host-meomry-file-readonly-guard.test.ts` — harden static scan

The existing source-scan test (line 136-143) must also detect:
- Import statements with banned specifiers (`import { writeFile, writeFileSync, ... } from 'node:fs'`), regardless of aliases (`as foo`).
- `fs.promises.writeFile(...)` style member access.
- `fsp.writeFile(...)` where `fsp` is an alias of `fs.promises`.
- `open(..., 'w'...)` with any string that includes `w` or `a` flag.

Implementation: parse the 4 protected file sources and:
1. Regex match imports: `/^import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*['"](node:)?fs(?:\/promises)?['"]/m` → split by `,`, trim, strip `as foo`, compare each specifier to the banned list. If any match → test fails with file + specifier.
2. Regex match banned identifiers anywhere in source (catches `fs.promises.writeFile` / `fsp.writeFile` / `wf(...)`): iterate banned names, check literal occurrence.
3. Banned list is a shared const exported from a test util or inlined — duplicated or not is fine, just must be exhaustive.

Add new test cases:
- **Alias bypass**: create a mock source string `import { writeFileSync as wf } from 'node:fs'; wf('/x','y');` → static scanner reports violation.
- **fs.promises**: mock `import { promises } from 'node:fs'; promises.writeFile(...)` → reports.
- **open with 'w' flag**: mock `import { open } from 'node:fs'; open('/x', 'w');` → reports.

Real scan over the 4 protected files must still return 0 violations (they legitimately don't write).

#### B3. Cross-check scan run

At end of hardening, run `npm run lint` (or `npx eslint src/retrieval/sources/host-memory-file*.ts`) as a one-time sanity check; adjust if any legitimate import trips the new rule.

## Out of scope — do NOT touch

- `src/backup/**` (23a sealed)
- `src/reconciliation/**`, `src/monitoring/**`, `src/scheduler/**`, `src/notify/**`, `src/sunset/**`, `src/alert/**`, `src/timeout/**`, `src/checkpoint/**`, `src/feature-flags/**`, `src/sdk/**`
- `src/retrieval/sources/host-memory-file*.ts` — do NOT change these (they already are readonly); the guard is meant to protect them, not be defined by them
- `src/retrieval/orchestrator.ts` / `profiles.ts` / `ranker*.ts` / `registry.ts`
- `src/api/**`, `src/mcp/**`, `src/index.ts`
- `src/db/migrations/**`, `src/core/contracts/**`
- Any test file except: `src/tests/source-kind-propagation.test.ts` (modify) + `src/tests/host-memory-file-readonly-guard.test.ts` (modify). NO new test files this batch.

## Forbidden patterns

- Production code MUST NOT sniff test env
- Tests MUST NOT touch real HOME / keychain / user config
- NO amend of prior commits — new commit on HEAD (`9731dba`)
- `.eslintrc.cjs` changes MUST stay scoped to 4 host-memory-file files (don't broaden to whole repo)
- Test threshold change from `>= 0` to `>= 4` is binding — don't water down if it triggers on current tree; find the real count and fix missing stores separately (or lower to actual count if `<4`, documenting why)
- Banned-import list MUST enumerate all write-capable fs APIs (don't stop at writeFileSync)

## Acceptance criteria

1. `rg -n "supportingStores.length >= 4" src/tests/source-kind-propagation.test.ts` ≥ 1 (threshold hardened)
2. `rg -n "supportingStores.length >= 0" src/tests/source-kind-propagation.test.ts` = 0 (tautology removed)
3. `rg -c "^test\\(" src/tests/source-kind-propagation.test.ts` ≥ 6 (was 5 per 19a brief; +1 negative regression)
4. `.eslintrc.cjs` contains `no-restricted-imports` entry scoped to host-memory-file files (`rg -n "no-restricted-imports" .eslintrc.cjs` ≥ 1)
5. `.eslintrc.cjs` banned-specifier list covers ≥ 15 write-capable fs identifiers
6. `src/tests/host-memory-file-readonly-guard.test.ts` updated to detect aliased imports (look for new regex patterns / specifier parsing)
7. `rg -c "^test\\(" src/tests/host-memory-file-readonly-guard.test.ts` ≥ previous count + 3 (new alias / promises / open('w') cases)
8. `npx eslint src/retrieval/sources/host-memory-file*.ts --no-eslintrc --config .eslintrc.cjs` exits 0 (real scan is clean)
9. `git diff HEAD -- src/backup/ src/reconciliation/ src/monitoring/ src/scheduler/ src/notify/ src/sunset/ src/alert/ src/timeout/ src/checkpoint/ src/feature-flags/ src/sdk/ src/retrieval/sources/host-memory-file-paths.ts src/retrieval/sources/host-memory-file-parser.ts src/retrieval/sources/host-memory-file-fts.ts src/retrieval/sources/host-memory-file-schema-router.ts src/retrieval/sources/host-memory-file.ts src/retrieval/orchestrator.ts src/retrieval/profiles.ts src/retrieval/ranker.ts src/retrieval/ranker-score.ts src/retrieval/registry.ts src/api/ src/mcp/ src/index.ts src/db/migrations/ src/core/contracts/` outputs empty
10. `git diff HEAD -- src/tests/` limited to 2 files: `source-kind-propagation.test.ts` + `host-memory-file-readonly-guard.test.ts` (no new test files)
11. `set -o pipefail; npm run build` exits 0; `set -o pipefail; npm test` ≥ 1199 pass / 0 fail (1196 + ≥ 3 new on readonly guard; +1 on source-kind; some may displace existing; floor is 1199)
12. Not-amend; new commit on HEAD (parent = `9731dba`)
13. Commit title prefix `fix(tests):` OR `fix(lint):` (codex picks based on which half dominates; both are acceptable)
14. Commit body:
    ```
    Close audit medium findings #51 + #52.

    #51 source-kind propagation test:
    - src/tests/source-kind-propagation.test.ts: replace tautological
      `supportingStores.length >= 0` with `>= 4` threshold per 19a brief.
      Add negative regression asserting threshold hard-fails below 4.
    - docs/architecture/source-kind-propagation.md: align Known gaps
      section with test-enforced invariant.

    #52 ESLint / readonly-guard alias bypass:
    - .eslintrc.cjs: extend host-memory-file override with
      no-restricted-imports banning writeFile/writeFileSync/appendFile/
      mkdirSync/rmSync/unlinkSync/renameSync/chmodSync/createWriteStream/
      open/openSync and siblings (≥ 15 specifiers) across node:fs + fs +
      node:fs/promises + fs/promises. Extends existing no-restricted-
      syntax with identifier-call selector for defense-in-depth.
    - src/tests/host-memory-file-readonly-guard.test.ts: source-scan now
      parses import specifiers (handles `as alias`) + catches fs.promises
      / open(...,'w'...) forms. New cases for aliased import, fs.promises
      write, open-with-write-flag.

    Scope: only .eslintrc.cjs + 2 existing test files +
    source-kind-propagation doc. Zero touches to src/backup / src/
    retrieval / src/api / src/mcp / other modules.

    Scope-risk: low
    Reversibility: clean
    ```

## Review checklist

- Does `supportingStores.length >= 4` actually assert (not wrapped in `>= 0` still)?
- Does negative regression test really fail when count < 4 (not just log)?
- Does `.eslintrc.cjs` override stay scoped to the 4 host-memory-file files (not repo-wide)?
- Banned-import list complete enough (≥ 15 entries)? Includes `open` / `openSync` for write-flag case?
- Does source-scan test catch `import { writeFileSync as wf }` — alias, not just literal?
- Does source-scan catch `fs.promises.writeFile` style?
- Does source-scan catch `open(path, 'w', ...)` with any flag containing w/a?
- Real scan over the 4 protected files returns 0 violations (they're already readonly)?
- New commit stacks on `9731dba` (not amend)?
- Test count delta: source-kind (+1), readonly-guard (+3) = 4 new, puts total ≥ 1200

## Commit discipline

- Single atomic commit, new stack on HEAD
- Prefix `fix(tests):` OR `fix(lint):` (codex picks)
- Body per Acceptance #14
- Files changed: `.eslintrc.cjs` + `src/tests/source-kind-propagation.test.ts` + `src/tests/host-memory-file-readonly-guard.test.ts` + `docs/architecture/source-kind-propagation.md`

## Resolution appendix (2026-04-21, post-24a.1)

### Acceptance #1 tradeoff
B3 chose to lock the current 0/6 store-support state as a binding assertion rather than
enforce `>= 4` directly on the main test, because no store schema currently backs
`source_kind`. The `>= 4` invariant lives in a pure helper `assertStoreSupportThreshold`
with an isolated regression test. When B6 (P8-029 schema migration) lands and support
reaches >= 4, the main-test assertion will be switched to `>= 4` at that time.

### Acceptance #8 reproducibility
The brief's literal `npx eslint ... --no-eslintrc` command does not work on ESLint v10+
(the `--no-eslintrc` flag was removed). The reproducible entry point is now
`npm run lint:readonly-guard` (B3 24a.1 follow-up), which pins `eslint@8.57.0` +
`@typescript-eslint/parser@7.18.0` via npx.

### Acceptance #14 commit body
`cd96831`'s commit body lost some backtick escaping via the shell HEREDOC; intent and
scope are preserved. Not re-amended — cosmetic.
