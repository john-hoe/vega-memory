# Batch 26a — Retrieval contract alignment: #29 queryless bootstrap + #31 ranker truth

## Context

Two Phase 8-era retrieval correctness bugs. Both filed 2026-04-17 (pre-audit). Bundled because both live in `src/retrieval/` and both are "advertised behavior ≠ actual logic" mismatches.

**#29** — bootstrap profile claims "wide session-start recall" but all sources (`promoted-memory.ts`, `wiki.ts`, `fact-claim.ts`, `graph.ts`, `archive.ts`) short-circuit on empty query. Combined with `host_memory_file` being previously disabled (#32, now resolved), bootstrap returned empty bundles when `query` was omitted — which the contract says is valid.

**#31** — `ranker-score.ts` hardcodes `recency = 1` and `safety_penalty = 0`. No access-frequency. Yet `score_breakdown` advertises all these fields, making logs/debugging misleading about what actually influences ranking.

Fix approach:
- **#29**: make the 5 bootstrap sources return top-N by recency when `query` is empty AND the profile is `bootstrap` (true wide recall, no FTS needed). Preserves the contract.
- **#31**: implement simple recency decay using existing `created_at` (no new DB columns). Narrow the contract for `safety_penalty` and `access_frequency` — remove them from `score_breakdown` unless backed by real signals.

No amend — new commit on HEAD (parent = `fc9eaf5`).

## Scope

### Part A — #29 queryless bootstrap

#### A1. Source short-circuit: add queryless branch

For each of the 5 bootstrap-participating sources, change the "empty query → return []" short-circuit to "empty query + bootstrap mode → return top-N by created_at DESC":

Files (check each; grep `query.length === 0` or similar):
- `src/retrieval/sources/promoted-memory.ts`
- `src/retrieval/sources/wiki.ts`
- `src/retrieval/sources/fact-claim.ts`
- `src/retrieval/sources/graph.ts`
- `src/retrieval/sources/archive.ts`

Pattern:
```ts
async search({ query, limit, profile, ... }: SearchInput): Promise<SourceRecord[]> {
  if (!query || query.trim().length === 0) {
    if (profile === "bootstrap") {
      // Queryless wide recall: return top-N by recency
      return listRecent({ limit, /* ... */ });
    }
    return [];  // Other profiles (lookup, followup, evidence) still require query
  }
  // Existing FTS/MATCH path
}
```

Each source needs a `listRecent(...)` helper that:
- Reads from the source's table(s) with `ORDER BY created_at DESC LIMIT ?`
- Wraps results in `SourceRecord` shape with the correct `source_kind`
- Respects the caller's `limit` (default sensibly, e.g. 10 per source)

If a source has no time column, use the best-available ordering (e.g. `updated_at`, `rank_hint`). Document the choice inline.

#### A2. `src/retrieval/profiles.ts` — pass profile name through to sources

If `profile` isn't already in `SearchInput`, add it. If it is, ensure the `bootstrap` profile dispatches without requiring `query`.

#### A3. Integration test

Add `src/tests/retrieval-bootstrap-queryless.test.ts` (new file, ≥ 5 cases):

1. **Bootstrap without query returns records**: seed 3 promoted memories + 2 wiki pages + 1 graph relation + 2 archive rows, call `resolveContext({ profile: "bootstrap" })` (no `query`), assert `bundle.records.length > 0` and records come from multiple sources.
2. **Bootstrap recency ordering**: seed 5 memories with different `created_at`; call bootstrap; assert the newest appears before the oldest in the returned bundle.
3. **Lookup without query returns empty**: call `resolveContext({ profile: "lookup" })` (no `query`), assert `bundle.records.length === 0` (non-bootstrap profiles still require query).
4. **Bootstrap respects limit budget**: seed 20 records; call bootstrap with budget.total_limit = 5; assert returned records ≤ 5.
5. **Bootstrap with query uses FTS path**: call `resolveContext({ profile: "bootstrap", query: "alpha" })`, assert the normal FTS path runs (not listRecent fallback); seed 1 matching + 3 non-matching; assert only 1 returned.

Hermetic: `:memory:` SQLite + `mkdtempSync`.

### Part B — #31 ranker truth

#### B1. `src/retrieval/ranker-score.ts` — implement simple recency decay

Replace the `recency = 1` hardcode with a real decay using `record.created_at`:

```ts
function computeRecency(created_at: Date | number, now: number = Date.now()): number {
  const ageMs = now - (created_at instanceof Date ? created_at.getTime() : created_at);
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  // Simple exponential decay with half-life ~7 days
  // recency = exp(-ln(2) * ageDays / 7), clamped to [0, 1]
  return Math.max(0, Math.min(1, Math.exp(-0.693 * ageDays / 7)));
}
```

Tunable via an option struct — but hardcode the half-life at 7 days unless brief callers pass something else. Pure function; no env / test sniff.

#### B2. `src/retrieval/ranker-score.ts` — narrow safety_penalty and access_frequency

Since there's no real safety signal today and no access-count column:
- Remove `safety_penalty` from the computed score (it's currently `0`, no-op — drop it)
- Remove `access_frequency` claim from `score_breakdown`

**OR** if either signal IS available somewhere I missed (check via grep):
- `safety_penalty`: if there's a `safety_score` / `harm_flag` field anywhere, use it
- `access_frequency`: if there's an `access_count` column anywhere, use it

If neither exists, narrow the contract:
- Update `score_breakdown` fields to `{ base, source_prior, recency }` (drop `safety_penalty` + `access_frequency`)
- Update any type definitions that claim these fields

Document the narrowing in a code comment: "access_frequency removed 2026-04-21 per #31 — no backing signal in current schema; re-add when access tracking lands".

#### B3. Tests — ranker regression

Add `src/tests/ranker-recency-decay.test.ts` (new file, ≥ 5 cases):

1. Recency = 1 when created_at = now
2. Recency ≈ 0.5 when created_at = now - 7 days (half-life)
3. Recency ≈ 0.25 when created_at = now - 14 days
4. Recency clamps to 0 for very old records (years ago)
5. Recency = 1 for future timestamps (shouldn't be negative exp)

Also add `src/tests/ranker-score-breakdown.test.ts` (new file, ≥ 3 cases):

1. score_breakdown contains exactly `{base, source_prior, recency}` — NOT `safety_penalty` or `access_frequency`
2. Record with newer created_at ranks higher than older record (all else equal)
3. Record with higher source_prior ranks higher than lower source_prior (all else equal)

If codex implements signal backfill instead of narrowing, adjust the test for that path; but either way, the contract must match the breakdown.

## Out of scope — do NOT touch

- `src/backup/**`, `src/promotion/**`, `src/usage/**`, `src/db/fts-query-escape.ts` (B2/B3/B4 sealed)
- `.eslintrc.cjs`, `package.json`, `src/tests/host-memory-file-readonly-guard.test.ts`, `src/tests/source-kind-propagation.test.ts`, `src/tests/candidate-promotion-ack-lineage.test.ts`, `src/tests/fts-match-escape.test.ts` (B3/B4 new tests)
- `src/reconciliation/**`, `src/monitoring/**`, `src/scheduler/**`, `src/notify/**`, `src/sunset/**`, `src/alert/**`, `src/timeout/**`, `src/checkpoint/**`, `src/feature-flags/**`, `src/sdk/**`
- `src/retrieval/sources/host-memory-file*.ts` (readonly-guarded; touched already)
- `src/api/**`, `src/mcp/**`, `src/index.ts`
- `src/db/migrations/**`, `src/core/contracts/**` (except minimal type narrowing if absolutely required; prefer updating consumer over narrowing contract file)

Allowed:
- `src/retrieval/profiles.ts` (if profile plumbing needs tweaking)
- `src/retrieval/sources/{promoted-memory,wiki,fact-claim,graph,archive}.ts`
- `src/retrieval/ranker-score.ts` + possibly `ranker.ts` (interface glue)
- `src/db/repository.ts` — only if listRecent-style helpers need to be added at the repository layer
- New test files (2-3)

## Forbidden patterns

- Production code MUST NOT sniff test env
- Tests MUST NOT touch real HOME / keychain / user config
- NO amend of prior commits — new commit on HEAD (parent = `fc9eaf5`)
- Bootstrap queryless path MUST use recency ordering (not random / insertion order)
- Ranker `recency` MUST be computed from real `created_at`, not hardcoded
- If narrowing the contract, MUST remove `safety_penalty` and `access_frequency` from BOTH the breakdown object AND any consumer type / log site (don't leave dangling emits)
- `resolveContext` error behavior on empty query + non-bootstrap profile unchanged (still empty bundle, not error)

## Acceptance criteria

1. `rg -nE "listRecent|ORDER BY created_at DESC" src/retrieval/sources/{promoted-memory,wiki,fact-claim,graph,archive}.ts` ≥ 5 (each source has a listRecent-style path)
2. `rg -n 'profile === "bootstrap"' src/retrieval/sources/` ≥ 3 (sources check profile name)
3. `src/tests/retrieval-bootstrap-queryless.test.ts` exists; `rg -c "^test\\(" src/tests/retrieval-bootstrap-queryless.test.ts` ≥ 5
4. `rg -nE "computeRecency|Math\\.exp" src/retrieval/ranker-score.ts` ≥ 1 (recency is real function)
5. `rg -n "recency = 1" src/retrieval/ranker-score.ts` = 0 (hardcode gone)
6. `rg -nE "safety_penalty|access_frequency" src/retrieval/ranker-score.ts` = 0 (narrowed out) OR both are backed by real signals (grep against repo shows the source)
7. `src/tests/ranker-recency-decay.test.ts` + `src/tests/ranker-score-breakdown.test.ts` exist; combined `rg -c "^test\\(" ...` ≥ 8
8. `git diff HEAD -- src/backup/ src/promotion/ src/usage/ src/db/fts-query-escape.ts .eslintrc.cjs package.json src/tests/host-memory-file-readonly-guard.test.ts src/tests/source-kind-propagation.test.ts src/tests/candidate-promotion-ack-lineage.test.ts src/tests/fts-match-escape.test.ts src/reconciliation/ src/monitoring/ src/scheduler/ src/notify/ src/sunset/ src/alert/ src/timeout/ src/checkpoint/ src/feature-flags/ src/sdk/ src/retrieval/sources/host-memory-file-paths.ts src/retrieval/sources/host-memory-file-parser.ts src/retrieval/sources/host-memory-file-fts.ts src/retrieval/sources/host-memory-file-schema-router.ts src/retrieval/sources/host-memory-file.ts src/api/ src/mcp/ src/index.ts src/db/migrations/` outputs empty (core/contracts allowed only if type narrowing is required)
9. `git diff HEAD -- src/tests/` shows only 2-3 new test files
10. `set -o pipefail; npm run build` exits 0; `set -o pipefail; npm test` ≥ 1223 pass / 0 fail (1215 + ≥ 8 new)
11. `npm run lint:readonly-guard` exits 0
12. Not-amend; parent of new commit = `fc9eaf5`
13. Commit title prefix `fix(retrieval):`
14. Commit body:
    ```
    Close retrieval contract gaps #29 + #31.

    #29 queryless bootstrap:
    - 5 bootstrap-participating sources (promoted-memory / wiki /
      fact-claim / graph / archive) now branch: empty query + profile ==
      "bootstrap" → ORDER BY created_at DESC LIMIT N (wide recall, no
      FTS needed); other profiles still return [] for empty query.
    - Profile name is plumbed through search input unchanged otherwise.
    - New src/tests/retrieval-bootstrap-queryless.test.ts (≥ 5 cases)
      covers queryless success, recency ordering, non-bootstrap still
      empty, budget respect, query-present FTS fallback.

    #31 ranker truth:
    - src/retrieval/ranker-score.ts: recency now computed from
      record.created_at via exponential decay (7-day half-life), not
      hardcoded 1.
    - safety_penalty + access_frequency removed from score_breakdown —
      no backing signals in current schema. Consumers / logs updated.
      Comment documents re-introduction path if/when signals land.
    - New src/tests/ranker-recency-decay.test.ts + ranker-score-
      breakdown.test.ts (≥ 8 combined cases).

    Scope: src/retrieval/profiles.ts + 5 sources + ranker-score.ts +
    3 new test files. Zero touches to reconciliation / monitoring /
    scheduler / notify / sunset / alert / backup / promotion / usage /
    feature-flags / sdk / api / mcp / migrations.

    Scope-risk: moderate (bootstrap semantics change visible to callers,
    though strictly additive; ranker contract narrowing is user-facing
    but matches reality — less misleading not more)
    Reversibility: clean
    ```

## Review checklist

- All 5 sources implement queryless branch (not just 2-3)?
- Queryless branch ONLY triggers for profile === "bootstrap" (not all profiles)?
- Recency decay uses record.created_at, not hardcoded or env-derived?
- Half-life of 7 days is sensible (not 1 hour or 10 years)?
- Narrowed fields (`safety_penalty`, `access_frequency`) removed from ALL sites: breakdown object, consumer types, logs, tests?
- New integration tests actually seed multi-source data (not just one table)?
- Ranker decay test verifies concrete values (≈ 0.5 at 7 days), not just monotonicity?
- New commit stacks on `fc9eaf5` (not amend)?
- `npm run lint:readonly-guard` still exit 0 (no fs writes introduced)?

## Commit discipline

- Single atomic commit, new stack on HEAD
- Prefix `fix(retrieval):`
- Body per Acceptance #14
- Files changed: `src/retrieval/profiles.ts` + 5 source files + `src/retrieval/ranker-score.ts` (+ maybe `ranker.ts`) + 3 new tests. Maybe `src/db/repository.ts` if shared listRecent helper belongs there.

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
