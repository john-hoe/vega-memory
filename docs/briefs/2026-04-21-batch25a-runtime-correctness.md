# Batch 25a — Runtime correctness: #46 candidate promotion + #47 FTS MATCH escape

## Context

Two independent runtime correctness bugs. Both filed 2026-04-21 during Phase 8 audit (the pre-B2 audit that filed #46-#49). Bundled because they touch orthogonal modules and don't risk scope collision.

**#46 candidate promotion global ack bleed** — `src/promotion/evaluator.ts` + `policy.ts` treat `usage.ack` history as a GLOBAL signal: any 3 `sufficient` acks across arbitrary unrelated records can promote a fresh candidate that never received direct user validation. Fix: bind ack evidence to the candidate/memory lineage.

**#47 FTS MATCH punctuation crash** — `searchFTS` / `searchRawArchives` / `HostMemoryFileAdapter.search` feed raw user text into SQLite FTS5 `MATCH ?`. Ordinary punctuation (`,`, `.`, `(`, `-`, etc.) raises `SqliteError: fts5: syntax error`. Fix: escape/tokenize before MATCH.

No amend — new commit on HEAD (parent = `b07755c`).

## Scope

### Part A — #46 candidate promotion lineage binding

#### A1. `src/promotion/evaluator.ts` — bind ack query to candidate lineage

Replace the global `ackStore.listRecent({ since, sufficiency: "sufficient" })` call with a lineage-scoped query. The candidate has:
- `candidate.id` (candidate row id)
- `candidate.record_id` (the record_id / memory_id the candidate would promote to)
- `candidate.session_id` (session that created it)
- `candidate.created_at`

The ack evidence that should count toward promotion is ONLY acks where:
- `ack.record_id === candidate.record_id` (same memory lineage) OR
- `ack.candidate_id === candidate.id` (direct candidate validation, if schema supports)
- AND `ack.created_at >= candidate.created_at` (time window unchanged)
- AND `ack.sufficiency === "sufficient"`

If `ackStore` doesn't expose a lineage-filterable method today, add one:
```ts
ackStore.listRecentForRecord(record_id: string, { since: Date, sufficiency: "sufficient" }): AckEvent[]
```

Keep the old `listRecent` signature for other callers (if any — grep first).

#### A2. `src/promotion/policy.ts` — update distinct-session count to count lineage-bound acks only

Where policy says "3 distinct sessions reached" etc, the counter now iterates over the lineage-filtered list from A1, not the global one. The threshold semantics stay the same (N distinct sessions), just the input set is scoped.

#### A3. Negative regression test

Add `src/tests/candidate-promotion-ack-lineage.test.ts` (new file, ≥ 3 cases):

1. **Unrelated acks cannot promote**: seed 3 `sufficient` acks across 3 different `record_id`s (NOT matching the candidate's record_id); create fresh candidate; call promotion evaluator; assert candidate stays in `pending` state.
2. **Lineage-bound acks can promote**: seed 3 `sufficient` acks all bound to `candidate.record_id`; assert candidate promotes.
3. **Mixed**: 2 lineage-bound + 1 unrelated — assert only the 2 lineage count, below threshold → no promote.

Hermetic: `mkdtempSync` tmp HOME + `:memory:` SQLite.

### Part B — #47 FTS MATCH escape/normalize

#### B1. New shared util `src/db/fts-query-escape.ts`

```ts
/**
 * Escape an arbitrary user string into a safe FTS5 MATCH expression.
 *
 * Strategy: tokenize on whitespace + punctuation, keep word-bearing tokens
 * (latin + CJK + digit), wrap each in double quotes (phrase-quoting makes
 * FTS5 treat the token literally), join with OR.
 *
 * Guarantees:
 * - Never throws on any input string.
 * - Empty/whitespace/all-punctuation input returns a no-op matcher "\"\""
 *   that produces zero results without SQL error.
 * - Preserves "any of these words" search semantics for natural language.
 * - Unicode-safe (CJK, accented latin).
 */
export function escapeFtsMatchQuery(raw: string): string;
```

Implementation sketch:
- Trim; if empty → return `'""'`
- Tokenize: split on `/[\s,;:!?()\[\]{}<>'"*+\-/\\|=@#$%^&~\`]+/u`
- Filter: keep tokens with ≥ 1 char matching `[\p{L}\p{N}]` (word-bearing)
- Escape internal double quotes in each token: `t.replace(/"/g, '""')`
- Wrap each in `"..."`
- Join with ` OR `
- If no tokens survive filter → return `'""'`

Keep it a pure function; no DB / env / test sniffing.

#### B2. `src/db/repository.ts` — apply escape at 2 call sites

Wherever `memories_fts MATCH ?` and `raw_archives_fts MATCH ?` are invoked, pass `escapeFtsMatchQuery(query)` instead of raw `query`. Keep the function signatures unchanged.

#### B3. `src/retrieval/sources/host-memory-file-fts.ts` (or wherever `host_memory_file_fts MATCH ?` lives) — apply escape

Same wrap: `MATCH escapeFtsMatchQuery(query)` via parameter binding.

Note: the `host-memory-file*.ts` files are readonly-guarded (ESLint + source-scan). Adding the `escapeFtsMatchQuery` import + wrapping the query string is NOT a write operation — it's a read/query path, which the guard permits. If ESLint trips on the import (shouldn't — import is not a write API), adjust by importing from `../../db/fts-query-escape.js` which is not an fs API.

#### B4. Regression tests

Add `src/tests/fts-match-escape.test.ts` (new file, ≥ 7 cases):

1. `escapeFtsMatchQuery("alpha, beta")` → `"alpha" OR "beta"` (or semantic equivalent; exact string tested)
2. `escapeFtsMatchQuery("")` → `""`
3. `escapeFtsMatchQuery("   ")` → `""`
4. `escapeFtsMatchQuery("!!!")` → `""` (all punctuation)
5. `escapeFtsMatchQuery('she said "hi"')` → tokens `she` / `said` / `hi`, each quoted
6. `escapeFtsMatchQuery("中文 搜索")` → `"中文" OR "搜索"` (CJK preserved)
7. `escapeFtsMatchQuery("name.with-dash_underscore")` → tokens split on `.`/`-`, each quoted

PLUS 3 integration regression cases against real SQLite:
- `repository.searchFTS("alpha, beta", ...)` returns results without throwing (empty result set or hits, just no SQL error)
- `repository.searchRawArchives("alpha, beta", ...)` ditto
- `HostMemoryFileAdapter.search({ query: "alpha, beta", ... })` ditto

Hermetic: `:memory:` SQLite + `mkdtempSync` tmp home.

Total new tests: ≥ 10 (7 unit + 3 integration).

## Out of scope — do NOT touch

- `src/backup/**` (B2 sealed)
- `.eslintrc.cjs` + `src/tests/host-memory-file-readonly-guard.test.ts` + `src/tests/source-kind-propagation.test.ts` + `package.json` (B3 sealed)
- `src/reconciliation/**`, `src/monitoring/**`, `src/scheduler/**`, `src/notify/**`, `src/sunset/**`, `src/alert/**`, `src/timeout/**`, `src/checkpoint/**`, `src/feature-flags/**`, `src/sdk/**`
- `src/retrieval/sources/host-memory-file-paths.ts` / `host-memory-file-parser.ts` / `host-memory-file-schema-router.ts` / `host-memory-file.ts` (main adapter) — only `host-memory-file-fts.ts` is allowed
- `src/retrieval/orchestrator.ts` / `profiles.ts` / `ranker.ts` / `ranker-score.ts` / `registry.ts`
- `src/api/**`, `src/mcp/**`, `src/index.ts`
- `src/db/migrations/**`, `src/core/contracts/**`

Allowed:
- `src/promotion/evaluator.ts` + `src/promotion/policy.ts` (for #46)
- `src/db/repository.ts` (for #47)
- `src/retrieval/sources/host-memory-file-fts.ts` (for #47, if that's where the adapter's fts query lives)
- New files: `src/db/fts-query-escape.ts` + 2 new test files

## Forbidden patterns

- Production code MUST NOT sniff test env
- Tests MUST NOT touch real HOME / keychain / user config
- NO amend of prior commits — new commit on HEAD (parent = `b07755c`)
- `escapeFtsMatchQuery` MUST be pure function (no DB / env / net / fs / test-env reads)
- MUST NOT introduce a new ackStore method if existing API can be filtered client-side (but if the client-side filter would scan millions of rows, a server-side method is fine)
- #46 fix MUST NOT weaken the threshold (still ≥ 3 distinct sessions); only the INPUT set changes, not the counting logic

## Acceptance criteria

1. `src/db/fts-query-escape.ts` exists; exports `escapeFtsMatchQuery`
2. `rg -n "escapeFtsMatchQuery" src/db/repository.ts` ≥ 2 (both FTS call sites)
3. `rg -n "escapeFtsMatchQuery" src/retrieval/sources/host-memory-file-fts.ts` ≥ 1
4. `src/tests/fts-match-escape.test.ts` exists; `rg -c "^test\\(" src/tests/fts-match-escape.test.ts` ≥ 10
5. `src/tests/candidate-promotion-ack-lineage.test.ts` exists; `rg -c "^test\\(" src/tests/candidate-promotion-ack-lineage.test.ts` ≥ 3
6. `rg -nE "listRecentForRecord|record_id.*===.*candidate" src/promotion/` ≥ 1 (lineage filter wired)
7. `git diff HEAD -- src/promotion/` limited to `evaluator.ts` + `policy.ts` (and maybe `ackStore` impl if filter was added there)
8. `git diff HEAD -- src/backup/ src/reconciliation/ src/monitoring/ src/scheduler/ src/notify/ src/sunset/ src/alert/ src/timeout/ src/checkpoint/ src/feature-flags/ src/sdk/ src/api/ src/mcp/ src/index.ts src/db/migrations/ src/core/contracts/ .eslintrc.cjs src/retrieval/orchestrator.ts src/retrieval/profiles.ts src/retrieval/ranker.ts src/retrieval/ranker-score.ts src/retrieval/registry.ts src/retrieval/sources/host-memory-file-paths.ts src/retrieval/sources/host-memory-file-parser.ts src/retrieval/sources/host-memory-file-schema-router.ts src/retrieval/sources/host-memory-file.ts src/tests/host-memory-file-readonly-guard.test.ts src/tests/source-kind-propagation.test.ts package.json` outputs empty
9. `git diff HEAD -- src/tests/` shows only 2 new test files: `fts-match-escape.test.ts` + `candidate-promotion-ack-lineage.test.ts`
10. `set -o pipefail; npm run build` exits 0; `set -o pipefail; npm test` ≥ 1211 pass / 0 fail (1201 + 10 new)
11. `npm run lint:readonly-guard` exits 0 (host-memory-file adapters still pass)
12. Not-amend; parent of new commit = `b07755c`
13. Commit title prefix `fix(retrieval):` OR `fix(promotion):` (codex picks based on which half dominates)
14. Commit body:
    ```
    Close runtime correctness findings #46 + #47.

    #46 candidate promotion ack lineage binding:
    - src/promotion/evaluator.ts + policy.ts: ack evidence queried by
      candidate.record_id (lineage-bound) instead of global listRecent.
      Distinct-session threshold logic unchanged; only input set is
      scoped.
    - New ackStore.listRecentForRecord(...) filter (if needed).
    - New src/tests/candidate-promotion-ack-lineage.test.ts (≥ 3 cases)
      covering unrelated-acks-no-promote, lineage-bound-promote,
      mixed-scenario.

    #47 FTS MATCH punctuation escape:
    - New src/db/fts-query-escape.ts: pure escapeFtsMatchQuery(raw)
      tokenizer that splits on whitespace + punctuation, filters to
      word-bearing tokens (latin + CJK + digit), phrase-quotes each
      token, joins with OR. Empty/all-punct input returns safe no-op
      matcher. Never throws.
    - src/db/repository.ts: searchFTS + searchRawArchives wrap raw query
      via escapeFtsMatchQuery at the 2 MATCH call sites.
    - src/retrieval/sources/host-memory-file-fts.ts: same wrap for
      host_memory_file_fts MATCH.
    - New src/tests/fts-match-escape.test.ts (≥ 10 cases): 7 unit cases
      for the escaper, 3 integration cases proving punctuation queries
      reach the 3 search paths without SQL error.

    Scope: src/promotion/{evaluator,policy}.ts + src/db/{repository,
    fts-query-escape}.ts + src/retrieval/sources/host-memory-file-fts.ts
    + 2 new test files. Zero touches to reconciliation / monitoring /
    scheduler / notify / sunset / alert / backup / timeout / feature-
    flags / sdk / api / mcp / migrations / contracts / eslint / other
    host-memory-file files / retrieval orchestrator/ranker/profiles.

    Scope-risk: moderate (promotion semantics change is user-visible,
    though strictly more conservative; FTS escape is additive hardening)
    Reversibility: clean (revert the 2 commits; old behavior restored)
    ```

## Review checklist

- #46: ack lineage filter is the ONLY behavior change; threshold count stays at ≥ 3 distinct sessions?
- #46: unrelated-acks-no-promote test really proves 3 unrelated acks don't trigger promotion?
- #46: the filter is applied at query time (not post-hoc filtering of full result) — perf-aware?
- #47: `escapeFtsMatchQuery` is pure (no DB / env / test-env reads)?
- #47: empty/all-punctuation input returns safe no-op (no SQL error)?
- #47: CJK preserved in tokenization (not stripped as non-word)?
- #47: all 3 MATCH call sites wrapped (not just 1-2)?
- #47: real integration tests hit SQLite with `"alpha, beta"` query without throwing?
- Readonly-guard test still passing (didn't break host-memory-file-fts.ts readonly posture)?
- New commit stacks on `b07755c` (not amend)?

## Commit discipline

- Single atomic commit, new stack on HEAD
- Prefix `fix(retrieval):` OR `fix(promotion):` (codex picks)
- Body per Acceptance #14
- Files changed: `src/promotion/evaluator.ts` + `src/promotion/policy.ts` + `src/db/repository.ts` + new `src/db/fts-query-escape.ts` + `src/retrieval/sources/host-memory-file-fts.ts` + 2 new test files. Maybe `ackStore` impl if listRecentForRecord was added there.
