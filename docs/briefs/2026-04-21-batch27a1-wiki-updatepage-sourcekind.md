# Batch 27a.1 — Close B6 review: wiki updatePage source_kind preservation + main-test threshold wire

## Context

B6 review of `f32b01a` returned PASS (not SEAL PASS) with 1 MEDIUM + 1 LOW:

- **LOW (real bug)**: `src/wiki/page-manager.ts` `updatePage()` method rebuilds `nextPage` without carrying `source_kind`, and the SQL `UPDATE` statement doesn't write it. Result: `createPage()` / `getPage()` surface the field, but `updatePage()` silently drops it — page-manager surface inconsistency.
- **MEDIUM**: B6's main test currently asserts `supportingStores.length === 6` (exact equality) which is actually STRICTER than `>= 4` (any regression fails the test). But reviewer's brief-literal interpretation says the `assertStoreSupportThreshold` helper should be called on the main path, not just in isolation. Wire the helper call additively — defense-in-depth at the same call site.

No amend — new commit on HEAD (parent = `f32b01a`).

## Scope

### 1. `src/wiki/page-manager.ts` — fix `updatePage()` to preserve source_kind

Audit lines ~505 + ~569 (reviewer-cited). Two sub-fixes:

**1a.** Where `updatePage` builds `nextPage` from the current page + user updates, include `source_kind: current.source_kind` (or accept override from input if schema allows; otherwise just preserve).

**1b.** Extend the SQL `UPDATE wiki_pages SET ... WHERE id = ?` statement to include `source_kind = ?` with the preserved value.

If `updatePage` input schema permits changing source_kind explicitly (unusual but possible for admin/migration tools), honor that; otherwise preservation is the default.

### 2. `src/tests/source-kind-propagation.test.ts` — wire `assertStoreSupportThreshold` at main test call site

Currently the main test asserts `supportingStores.length === 6` (exact). Add immediately before:
```ts
assertStoreSupportThreshold(supportingStores, 4, STORE_SUPPORT_LABELS);  // defense-in-depth: threshold invariant holds
assert.equal(supportingStores.length, 6);  // current state exact match
```

The helper throws if `supportingStores.length < 4`. Exact assertion still catches regression `6 → 5` / `6 → 0` scenarios. The additive helper call provides a layer that survives if the exact assertion ever relaxes during future refactoring.

### 3. `src/tests/source-kind-propagation.test.ts` — add wiki updatePage regression

New test case (≥ 1 added, bringing total to 10):
```ts
test("wiki updatePage preserves source_kind across edits", () => {
  // seed a wiki_page with source_kind = "wiki" via createPage
  // call updatePage({ id, title: "new title" })
  // assert updated page still has source_kind = "wiki"
  // call updatePage({ id, title: "another", source_kind: "vega_memory" }) [if schema permits]
  //   either: source_kind changed to "vega_memory" (admin path accepted)
  //   or: source_kind stays "wiki" (strict preservation)
  // document which behavior is correct via comment
});
```

Pick the behavior that matches what `updatePage`'s input schema actually allows. If the input type doesn't include source_kind, assert strict preservation. If it does, test both cases.

### 4. Resolution appendix in 27a brief

Append to `docs/briefs/2026-04-21-batch27a-source-kind-schema-migration.md`:

```md
## Resolution appendix (2026-04-21, post-27a.1)

### B6 review LOW — wiki updatePage source_kind preservation
Fixed in 27a.1 (f32b01a's updatePage path dropped source_kind; now preserved).

### B6 review MEDIUM — threshold wiring
Main test assertion `supportingStores.length === 6` is actually stricter
than the brief's `>= 4` requirement (any regression below 6 fails the
test). 27a.1 additionally calls `assertStoreSupportThreshold(..., 4)`
at the main call site for defense-in-depth, so the threshold invariant
is now enforced at both the helper regression AND the main integration
path.

### Deferred
`usage_ack` source_kind persistence (not just echo) remains deferred.
Brief 27a explicitly allowed this; B6 codex confirmed echo-only path
is intentional. Future batch can persist to a usage_acks JSON column
if analytics requires it.
```

## Out of scope — do NOT touch

- Everything outside: `src/wiki/page-manager.ts` + `src/tests/source-kind-propagation.test.ts` + 2 brief docs
- No other files — tight scope corrective

## Forbidden patterns

- NO amend of prior commits — new commit on HEAD (parent = `f32b01a`)
- NO new source files
- NO changes to wiki surface schema unless strictly required for preservation
- `updatePage` fix MUST be minimal: preserve current source_kind when caller doesn't override; don't invent new input schema surface
- Threshold helper call MUST be additive (before `=== 6`), not replacing the exact assertion

## Acceptance criteria

1. `rg -n "source_kind" src/wiki/page-manager.ts` ≥ 6 (constructor + createPage + getPage + updatePage + update SQL + result reconstruction — 4-6 expected, floor 6)
2. Wiki updatePage SQL statement includes `source_kind = ?` (grep `UPDATE wiki_pages.*source_kind` or adjacent context)
3. `rg -n "assertStoreSupportThreshold\\(supportingStores" src/tests/source-kind-propagation.test.ts` ≥ 1 (helper wired at main call site, not just isolated regression)
4. `rg -c "^test\\(" src/tests/source-kind-propagation.test.ts` ≥ 10 (was 9; +1 wiki updatePage regression)
5. `docs/briefs/2026-04-21-batch27a-source-kind-schema-migration.md` contains `## Resolution appendix`
6. `git diff HEAD --name-only` ⊆ `{src/wiki/page-manager.ts, src/tests/source-kind-propagation.test.ts, docs/briefs/2026-04-21-batch27a-source-kind-schema-migration.md, docs/briefs/2026-04-21-batch27a1-wiki-updatepage-sourcekind.md}`
7. `set -o pipefail; npm run build` exits 0; `set -o pipefail; npm test` ≥ 1233 pass / 0 fail (1232 + 1 new)
8. `npm run lint:readonly-guard` exits 0
9. Not-amend; parent of new commit = `f32b01a`
10. Commit title prefix `fix(wiki):`
11. Commit body:
    ```
    Close B6 review: wiki updatePage source_kind preservation + threshold wire.

    - src/wiki/page-manager.ts: updatePage() now preserves source_kind
      across the nextPage rebuild + SQL UPDATE. Resolves page-manager
      surface inconsistency where createPage/getPage exposed the field
      but updatePage silently dropped it.
    - src/tests/source-kind-propagation.test.ts: assertStoreSupportThreshold
      now called directly at main integration path (before the
      supportingStores.length === 6 exact match) — defense-in-depth for
      the >= 4 invariant. Added 1 wiki updatePage regression test.
    - 27a brief Resolution appendix documents the B6 review closure.

    Scope: 2 files + 2 brief docs. Zero touches to other code.

    Scope-risk: minimal
    Reversibility: clean
    ```

## Review checklist

- `updatePage` preserves `source_kind` in BOTH the `nextPage` object AND the SQL UPDATE binding?
- Threshold helper really invoked at main path (not wrapped in try/catch that masks failure)?
- New wiki updatePage test seeds real data + reads back asserting preserved?
- Scope strictly limited to 2 files + 2 docs?
- New commit stacks on `f32b01a` (not amend)?

## Commit discipline

- Single atomic commit
- Prefix `fix(wiki):`
- Body per Acceptance #11

## Execution status

- 27a.1 is implemented as a tight-scope corrective: `src/wiki/page-manager.ts`
  preserves `source_kind` across `updatePage()`, and
  `src/tests/source-kind-propagation.test.ts` now exercises the main-path
  threshold helper plus a wiki `updatePage` regression.
- Resolution details are appended to
  `docs/briefs/2026-04-21-batch27a-source-kind-schema-migration.md`.
