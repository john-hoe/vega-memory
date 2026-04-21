# Batch 25a.1 — Close B4 review MEDIUM: vega_memory lineage test + minor nits

## Context

B4 review of `5fb0cc8` returned PASS (not SEAL PASS) with one MEDIUM + two LOW nits:
- **MEDIUM**: `evaluator.ts` supports both `candidate:<id>` and `vega_memory:<id>` lineage keys, but the new regression test only covers `candidate:<id>`. If the `vega_memory` branch drifts or gets misnamed, no regression catches it.
- **LOW**: `src/db/fts-query-escape.ts:20` has `replace(/"/g, '""')` which is dead code — `"` is already stripped by the splitter at :2
- **LOW**: `src/promotion/evaluator.ts:98-102` still has a legacy `listRecent` fallback — not harmful (prod path uses `listRecentForRecord`) but leaves global-ack semantics reachable via fallback

Fix MEDIUM (required for seal). Decide case-by-case on LOWs: clean up the dead `replace` (trivial), but KEEP the `listRecent` fallback because removing it would require verifying no other caller still depends on it (scope creep into a separate discovery task).

No amend — new commit on HEAD (parent = `5fb0cc8`).

## Scope

### 1. `src/tests/candidate-promotion-ack-lineage.test.ts` — add vega_memory lineage test

Append a 4th test case that seeds ack evidence under the `vega_memory:<id>` record_ids key (matching the promoted-memory lineage that `createFromCandidate` uses), and asserts the candidate still promotes correctly via the same 3-distinct-sessions threshold.

Pattern:
```ts
test("vega_memory lineage promotes when acks bind to promoted memory id", async () => {
  // Seed a candidate whose id matches the vega_memory record_id used by
  // resolved_checkpoints after promotion.
  // Ack 3 checkpoints whose record_ids JSON array includes
  // `vega_memory:<candidate.id>`.
  // Assert: policy.evaluate(...) returns promote=true.
});
```

Use the same harness pattern as the existing 3 cases (mkdtempSync tmp HOME + :memory: SQLite + same store/evaluator/policy factories). Total test count goes from 3 → 4 in this file.

### 2. `src/db/fts-query-escape.ts` — drop dead `replace(/"/g, '""')`

The tokenizer at line ~2 splits on punctuation INCLUDING `"`, so tokens never contain quotes. The subsequent `t.replace(/"/g, '""')` at line ~20 is unreachable. Remove it — tokens are wrapped in `"${token}"` directly.

If a future change ever removes `"` from the splitter pattern, the quote-doubling step may come back. But today it's dead. Removing avoids the false-security signal.

### 3. LEAVE `src/promotion/evaluator.ts:98-102` legacy fallback alone

The `listRecent` fallback is a compat seam for code paths that still use the old interface (e.g. potentially older tests or shim stores). Removing would require:
- Grepping all callers of `createAckStore` / `AckStore` type
- Confirming `listRecentForRecord` is provided on every path
- Possibly adjusting tests that inject mock stores

That's a discovery exercise, not a tight corrective. Document the decision in the commit body so future readers know it's deliberate, not forgotten.

## Out of scope — do NOT touch

- `src/backup/**`, `.eslintrc.cjs`, `package.json`, `src/retrieval/sources/host-memory-file*.ts`, `src/db/repository.ts`, `src/promotion/policy.ts`, `src/usage/ack-store.ts` (already landed in B4 — not touching)
- Everything listed in 25a out-of-scope still applies
- No new files beyond what's below

Allowed:
- `src/tests/candidate-promotion-ack-lineage.test.ts` (add 1 test)
- `src/db/fts-query-escape.ts` (remove dead replace)
- No other file

## Forbidden patterns

- NO amend of `5fb0cc8` — new commit on HEAD
- NO removal of the `listRecent` legacy fallback (discovery scope creep)
- NO changes to MATCH call sites or escape function semantics — only remove the dead `replace`
- Production code MUST NOT sniff test env
- Tests MUST NOT touch real HOME / keychain / user config

## Acceptance criteria

1. `rg -c "^test\\(" src/tests/candidate-promotion-ack-lineage.test.ts` ≥ 4
2. `rg -n "vega_memory:" src/tests/candidate-promotion-ack-lineage.test.ts` ≥ 1 (new lineage test references the correct key)
3. `rg -n "replace\\(/\\\"/g" src/db/fts-query-escape.ts` = 0 (dead replace removed)
4. `git diff HEAD --name-only` ⊆ `{src/tests/candidate-promotion-ack-lineage.test.ts, src/db/fts-query-escape.ts, docs/briefs/2026-04-21-batch25a1-ack-lineage-vega-memory-case.md}` (brief file may be staged separately)
5. `git diff HEAD -- src/backup/ src/reconciliation/ src/monitoring/ src/scheduler/ src/notify/ src/sunset/ src/alert/ src/timeout/ src/checkpoint/ src/feature-flags/ src/sdk/ src/retrieval/ src/api/ src/mcp/ src/index.ts src/db/migrations/ src/core/contracts/ src/db/repository.ts src/promotion/ src/usage/ .eslintrc.cjs package.json` empty (only the 2 permitted files touched)
6. `set -o pipefail; npm run build` exits 0; `set -o pipefail; npm test` ≥ 1215 pass / 0 fail (1214 + 1 new test)
7. `npm run lint:readonly-guard` exits 0
8. Not-amend; parent of new commit = `5fb0cc8`
9. Commit title prefix `test(promotion):` OR `chore(cleanup):` (codex picks)
10. Commit body:
    ```
    Close B4 review MEDIUM + drop dead FTS replace.

    - src/tests/candidate-promotion-ack-lineage.test.ts: add 4th case
      covering vega_memory:<id> lineage (promote-to-memory branch) with
      3 distinct-session acks. Existing 3 cases only exercised the
      candidate:<id> lineage. Symmetric regression now guards both
      branches of evaluator's listRecentForRecord(...) calls.
    - src/db/fts-query-escape.ts: remove dead `.replace(/"/g, '""')`.
      Tokens never contain " because the splitter at line 2 treats it
      as punctuation.

    Deliberately kept:
    - src/promotion/evaluator.ts legacy listRecent fallback remains.
      Removing requires auditing all AckStore callers; tracked separately.

    Scope: 2 files + 1 brief doc. Zero source-behavior changes beyond
    the dead-code removal (tokenizer output identical pre/post).

    Scope-risk: minimal
    Reversibility: clean
    ```

## Review checklist

- Does the new test reference `vega_memory:<candidate.id>` key correctly (matching what evaluator looks for)?
- Does the new test really promote (not just reach threshold but actually return promote=true)?
- Does removing the dead `replace` break any snapshot / test that asserts specific escape output? Double-check the 10 existing escape tests.
- Does the commit body accurately explain why legacy fallback is kept deliberately?
- New commit stacks on `5fb0cc8` (not amend)?

## Commit discipline

- Single atomic commit, new stack on HEAD
- Prefix `test(promotion):` OR `chore(cleanup):`
- Body per Acceptance #10
- Files changed: `src/tests/candidate-promotion-ack-lineage.test.ts` + `src/db/fts-query-escape.ts`
