# Batch 26a.1 — Close B5 review MEDIUM: bump score_version + pure recency decay + comment cleanup

## Context

B5 review of `34ed7b6` returned PASS (not SEAL PASS) with 2 MEDIUM + 2 LOW:

- **MED 1**: `score_version` still `"v1.0"` but ranker formula changed (recency now real) and `score_breakdown` shape changed (no more `safety_penalty`/`access_frequency`). Consumers replaying old vs new acks/checkpoints see identical version — misleading.
- **MED 2**: recency adds `RECENCY_ZERO_FLOOR = 0.001` on top of `exp(-ln2 * age/7d)` — snaps old records to 0 around day ~70. More aggressive than the pure half-life brief claimed. Reviewer flagged as inconsistent with "7-day half-life" semantic.
- **LOW 1**: `access_frequency` appears in a code comment in `ranker-score.ts` → Acceptance #6's literal grep fails.
- **LOW 2**: 5 existing tests modified. These are consequential adjustments to the contract changes (empty query allowed; breakdown shape changed). NOT fixing — these are necessary and correct changes.

Fix the first 3; accept LOW 2 as intentional scope expansion documented in brief 26a Resolution appendix.

No amend — new commit on HEAD (parent = `34ed7b6`).

## Scope

### 1. Bump `score_version` from `"v1.0"` → `"v1.1"`

Grep: `rg -n '"v1\\.0"' src/retrieval/` — reviewer flagged:
- `src/retrieval/ranker.ts:22`
- `src/retrieval/orchestrator.ts:78`
- `src/tests/retrieval-orchestrator.test.ts:117`

Change each `"v1.0"` → `"v1.1"`. If more sites exist (consumer code, tests), update all. Search scope: entire repo for `score_version.*v1\\.0` or similar. Anything that hard-codes the version comparator to `"v1.0"` must follow.

### 2. Remove `RECENCY_ZERO_FLOOR` — use pure `exp` decay

`src/retrieval/ranker-score.ts:9` defines `RECENCY_ZERO_FLOOR = 0.001`. `src/retrieval/ranker-score.ts:68` applies it.

Remove the constant + remove the clamp-to-floor step. Let `Math.exp(-0.693 * ageDays / 7)` return its natural value, clamped only to `[0, 1]` (upper bound at 1 for future timestamps, floor at 0 for negative-exp impossibilities; but `Math.max(0, ...)` vs `0.001` — keep `Math.max(0, ...)`).

After change, `recency(now - 70 days)` ≈ `exp(-0.693 * 70 / 7)` ≈ `exp(-6.93)` ≈ `0.00097` (not 0). That's the brief's pure semantic.

Update corresponding test in `src/tests/ranker-recency-decay.test.ts`:
- Existing test for "clamps to 0 for very old records (years ago)" may fail — OLD record at 5 years age = `exp(-0.693 * 1825/7)` ≈ `2.8e-79` which still rounds to `0` in JS double (underflow). So floor=0 still applies via underflow, just not via explicit floor constant.
- If test asserts exact 0, fine — underflow gets there.
- If test asserts exact 0 at 70 days, need to change to "very old" (years).

Add one more test: `recency(now - 70 days) > 0` (proving no artificial floor at day 70).

### 3. Remove `access_frequency` from comments in `ranker-score.ts`

Brief 26a Acceptance #6 required `rg -nE "safety_penalty|access_frequency" src/retrieval/ranker-score.ts` = 0. Comments count. Remove any mention from comments, including the "re-introduction path" comment if it specifically names `access_frequency`.

If useful documentation needs to reference the removed concept, move it to `docs/architecture/` (but do NOT create a new doc — keep this batch tight; just clean the comment).

### 4. Brief 26a Resolution appendix

Append to `docs/briefs/2026-04-21-batch26a-retrieval-contract.md`:

```md
## Resolution appendix (2026-04-21, post-26a.1)

### Acceptance #6 literal compliance
`access_frequency` was removed from ranker-score.ts comments in 26a.1.

### Acceptance #9 scope expansion
B5 commit `34ed7b6` modified 5 existing tests in addition to the 3 new
test files:
- src/tests/retrieval-budget.test.ts
- src/tests/retrieval-bundler.test.ts
- src/tests/retrieval-ranker.test.ts
- src/tests/contracts-intent-schema-sync.test.ts
- src/tests/wiring-integration.test.ts

These are necessary and correct consequences of the contract changes:
- Empty-query schema acceptance (wiring-integration + contracts-intent-schema-sync)
- Score breakdown shape change (retrieval-budget, retrieval-bundler, retrieval-ranker)

Reverting would leave tests asserting outdated contracts. The scope
expansion is accepted as intentional.

### Ranker formula semantics
B5 included `RECENCY_ZERO_FLOOR = 0.001` which 26a.1 removed. Current
behavior is pure `exp(-ln2 * age/7d)` clamped to [0, 1]; JS double
underflow naturally delivers 0 for record ages > ~years.

### Score version
Bumped to `"v1.1"` in 26a.1. Consumers that stored `"v1.0"` acks
continue to reflect the old ranker formula; new acks get `"v1.1"`.
```

## Out of scope — do NOT touch

- Everything NOT listed below stays:
  - `src/backup/`, `src/promotion/`, `src/usage/`, `.eslintrc.cjs`, `package.json`, all B2-B4 commits' files
  - `src/reconciliation/`, `src/monitoring/`, `src/scheduler/`, `src/notify/`, `src/sunset/`, `src/alert/`, `src/timeout/`, `src/checkpoint/`, `src/feature-flags/`, `src/sdk/`
  - `src/retrieval/sources/host-memory-file*.ts` (readonly-guarded)
  - `src/retrieval/sources/{promoted-memory,wiki,fact-claim,graph,archive}.ts` (B5 landed)
  - `src/retrieval/profiles.ts` (B5 landed)
  - `src/api/`, `src/mcp/`, `src/index.ts`, `src/db/migrations/`, `src/db/repository.ts`
  - `src/core/contracts/intent.ts` (B5 landed)
  - The 5 existing tests B5 modified (ok as-is)
  - Any new test files from B5 (bootstrap-queryless / ranker-recency-decay / ranker-score-breakdown)

Allowed:
- `src/retrieval/ranker.ts` (score_version bump)
- `src/retrieval/orchestrator.ts` (score_version bump)
- `src/retrieval/ranker-score.ts` (remove FLOOR + clean comment)
- `src/tests/retrieval-orchestrator.test.ts` (bump assertion to `v1.1`)
- `src/tests/ranker-recency-decay.test.ts` (add day-70 > 0 assertion; adjust very-old test if needed)
- `docs/briefs/2026-04-21-batch26a-retrieval-contract.md` (Resolution appendix)

## Forbidden patterns

- NO amend of `34ed7b6` — new commit on HEAD (parent = `34ed7b6`)
- NO revert of B5's 5 modified existing tests (they're correct)
- NO new source files, NO new test files — only small edits + one doc appendix
- `score_version` bump MUST be consistent everywhere — grep all sites and update together (no leftover `v1.0` references in production code or tests that assert the version)
- Pure `exp` decay MUST NOT add any magic floor / ceiling other than natural `[0, 1]` clamp

## Acceptance criteria

1. `rg -n '"v1\\.0"' src/retrieval/ src/tests/` = 0 (all bumped to v1.1)
2. `rg -n '"v1\\.1"' src/retrieval/ src/tests/` ≥ 3 (bumped in code + test)
3. `rg -n "RECENCY_ZERO_FLOOR" src/retrieval/ranker-score.ts` = 0 (constant removed)
4. `rg -nE "safety_penalty|access_frequency" src/retrieval/ranker-score.ts` = 0 (literal Acceptance #6 pass)
5. Recency at 70 days: `Math.exp(-0.693 * 70 / 7)` ≈ `0.00097` — assertion in `ranker-recency-decay.test.ts` verifies it's > 0 (test added or adjusted)
6. `docs/briefs/2026-04-21-batch26a-retrieval-contract.md` contains `## Resolution appendix`
7. `git diff HEAD --name-only` ⊆ `{src/retrieval/ranker.ts, src/retrieval/orchestrator.ts, src/retrieval/ranker-score.ts, src/tests/retrieval-orchestrator.test.ts, src/tests/ranker-recency-decay.test.ts, docs/briefs/2026-04-21-batch26a-retrieval-contract.md, docs/briefs/2026-04-21-batch26a1-ranker-truth-finalize.md}`
8. `set -o pipefail; npm run build` exits 0; `set -o pipefail; npm test` ≥ 1228 pass / 0 fail (floor = 1228; may be 1229 if a new test was added)
9. `npm run lint:readonly-guard` exits 0
10. Not-amend; parent of new commit = `34ed7b6`
11. Commit title prefix `chore(retrieval):` OR `fix(retrieval):`
12. Commit body:
    ```
    Finalize ranker truth (closes B5 review MEDIUM).

    - score_version bumped "v1.0" → "v1.1" across ranker.ts, orchestrator.ts,
      and retrieval-orchestrator.test.ts. Consumers replaying pre-26a acks
      stay at "v1.0"; new acks reflect the real recency formula + narrowed
      breakdown under "v1.1".
    - src/retrieval/ranker-score.ts: removed RECENCY_ZERO_FLOOR = 0.001.
      Pure exp(-ln2 * ageDays / 7) clamped only to [0, 1]; JS double
      underflow handles truly ancient records naturally.
    - Removed lingering access_frequency mention from ranker-score.ts
      comments (Acceptance #6 literal pass).
    - Added recency > 0 at day-70 assertion to ranker-recency-decay test.
    - Brief 26a Resolution appendix documents: MED fix, scope-expanded
      test list, and retained legacy listRecent fallback in evaluator.

    Scope: ranker / orchestrator / ranker-score + 1 test + brief appendix.
    Zero new source / new tests beyond the single appended assertion.

    Scope-risk: minimal
    Reversibility: clean
    ```

## Review checklist

- All `v1.0` sites bumped (grep the whole repo once more; don't leave stragglers)?
- Pure exp decay — no magic floor?
- Day-70 assertion really > 0 (not just ≠ 0; use `>`)?
- `access_frequency` gone from comments — no references anywhere in `ranker-score.ts`?
- New commit stacks on `34ed7b6` (not amend)?
- `npm test` still ≥ 1228 (can be 1229 if new assertion counted as new test; brief's `test(` count may not reflect assertion-only change)?

## Commit discipline

- Single atomic commit
- Prefix `chore(retrieval):` OR `fix(retrieval):`
- Body per Acceptance #12
- Files changed: 3 src files + 2 test files + 1 brief doc
