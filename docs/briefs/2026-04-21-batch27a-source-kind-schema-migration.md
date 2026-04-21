# Batch 27a — Close 🟡 P8-029: source_kind schema migration + usage_ack echo

## Context

P8-029 is one of the 4 remaining 🟡 gaps. Framework work (19a integration test + 25a threshold helper) is done, but the actual DB schema changes are still pending:
- 6 store tables lack a `source_kind` column
- Backfill for existing rows
- Repository insert/read paths don't pass source_kind through
- usage_ack handler doesn't echo/persist source_kind

After this batch lands, the 25a `source-kind-propagation.test.ts` threshold switches from "0/6 supporting (current)" to "6/6 supporting" and the main assertion becomes `>= 4` real invariant (not just a helper-isolated regression).

**Note on inline DDL pattern**: this repo uses inline CREATE TABLE IF NOT EXISTS in `src/db/schema.ts` (no separate migrations directory). Additive column changes use the pattern:
```ts
// After initial CREATE TABLE block
try { db.exec("ALTER TABLE X ADD COLUMN source_kind TEXT"); } catch { /* column exists */ }
```
Or: `PRAGMA table_info(X)` check then conditional ALTER. Codex picks the cleaner form consistent with existing schema.ts.

No amend — new commit on HEAD (parent = `016e056`).

## Scope

### 1. `src/db/schema.ts` — add source_kind column to 6 tables

Tables:
- `candidate_memories`
- `memories` (promoted; already has a `source` legacy text field — `source_kind` is additive, not replacing)
- `wiki_pages`
- `fact_claims`
- `relations` (graph edges)
- `raw_archives`

Each gets:
```sql
ALTER TABLE <table> ADD COLUMN source_kind TEXT
```

Add these ALTER statements AFTER the CREATE TABLE blocks, wrapped in try/catch (SQLite re-ALTER fails if column exists; idempotent on re-init). OR use `PRAGMA table_info` precheck.

Target enum values (from P8-002.4):
`"host_memory_file" | "vega_memory" | "wiki" | "fact_claim" | "graph" | "archive"`

No NOT NULL constraint (column is nullable for backward compat with pre-migration rows that haven't been backfilled).

### 2. Backfill existing rows

Right after the ALTER pass, run a single-batch UPDATE for each table:

```sql
UPDATE candidate_memories SET source_kind = 'vega_memory' WHERE source_kind IS NULL;
UPDATE memories SET source_kind = 'vega_memory' WHERE source_kind IS NULL;
UPDATE wiki_pages SET source_kind = 'wiki' WHERE source_kind IS NULL;
UPDATE fact_claims SET source_kind = 'fact_claim' WHERE source_kind IS NULL;
UPDATE relations SET source_kind = 'graph' WHERE source_kind IS NULL;
UPDATE raw_archives SET source_kind = 'archive' WHERE source_kind IS NULL;
```

Defaults reflect the canonical kind of records typically in each table. Future rows must specify `source_kind` explicitly via insert paths (step 3).

If Postgres code path exists: guard the migration with `if (db.isPostgres) return;` (pattern from 12a.1).

### 3. Repository insert/read paths — accept and return source_kind

Files to audit:
- `src/db/repository.ts` — CRUD for memories + raw_archives
- `src/db/candidate-repository.ts` — candidate_memories
- `src/wiki/` — wiki_pages store (find the file)
- `src/fact-claim/` or similar — fact_claims store
- `src/graph/` or similar — relations store

For each table's INSERT path:
- Accept `source_kind: SourceKind` as an optional parameter (defaulting to the canonical kind for the table to preserve old caller behavior, but preferring callers to pass through explicitly)
- Write `source_kind` as the new column

For each table's SELECT path:
- Read `source_kind` column into the result row
- Preserve the field in returned `SourceRecord` / type

Keep diff minimal; don't restructure signatures. Add a new optional field.

### 4. `src/api/server.ts` + `src/mcp/server.ts` — usage_ack echo source_kind

Currently the usage_ack handler accepts a bundle confirmation but doesn't echo `source_kind`. Extend:

- Input: bundle records already carry `source_kind` (provenance). Handler accepts them.
- Output: ack receipt echoes `source_kind` in the response (if the bundle record had one).
- Persistence: optional for this batch. If `usage_acks` table has a `source_kinds` JSON column or similar, write there; otherwise defer persistence (the primary goal is echo, not storage).

Minimal change: in the ack response shape, include `echoed_source_kinds: string[]` (unique set from bundle records) OR per-record echo depending on existing response structure.

### 5. Update `src/tests/source-kind-propagation.test.ts` — flip threshold

Currently:
```ts
const CURRENT_MISSING_SOURCE_KIND_STORES = [...STORE_SUPPORT_LABELS] as const;  // all 6 missing
```

After migration, ALL 6 support source_kind. Update to:
```ts
const CURRENT_MISSING_SOURCE_KIND_STORES = [] as const;  // 0 missing — full support
```

Main assertion now passes naturally (supporting = 6 ≥ threshold 4). The `assertStoreSupportThreshold` helper regression stays as-is.

Also update `docs/architecture/source-kind-propagation.md` Known gaps section to state "all 6 stores now support source_kind as of 2026-04-21".

### 6. New tests — extend integration coverage

Add to existing `src/tests/source-kind-propagation.test.ts` (don't create new file — keep integration in one place):

1. **Backfill test**: pre-seed a row in each of 6 tables before the migration runs (simulating legacy data), run schema init, assert each row now has `source_kind` set to the canonical kind default.
2. **Insert with source_kind preserves it**: insert a `memories` row with `source_kind: "host_memory_file"` (not the default `vega_memory`), read back, assert equal.
3. **usage_ack echo**: build a retrieval response with records of mixed source_kinds, call `usage_ack`, assert `echoed_source_kinds` (or per-record) matches.

Total new tests: ≥ 3 added to the existing file.

### 7. Optional: `src/usage/ack-store.ts` persistence

If ack persistence of source_kind is trivial (single JSON column add), do it. Otherwise document as explicit deferral in commit body.

## Out of scope — do NOT touch

- `src/backup/**`, `.eslintrc.cjs`, `package.json`, `src/promotion/**`, `src/db/fts-query-escape.ts`, `src/retrieval/ranker-score.ts`, `src/retrieval/ranker.ts`, `src/retrieval/orchestrator.ts`, `src/retrieval/sources/{promoted-memory,wiki,fact-claim,graph,archive}.ts`, `src/retrieval/profiles.ts` (B2-B5 sealed; retrieval-side now reads source_kind through existing SourceRecord types that already expect the field)
- `src/reconciliation/**`, `src/monitoring/**`, `src/scheduler/**`, `src/notify/**`, `src/sunset/**`, `src/alert/**`, `src/timeout/**`, `src/checkpoint/**`, `src/feature-flags/**`, `src/sdk/**`
- `src/retrieval/sources/host-memory-file*.ts` (readonly-guarded)
- `src/index.ts`
- `src/core/contracts/intent.ts` (B5 sealed)

Allowed:
- `src/db/schema.ts` (primary)
- `src/db/repository.ts` (memories + raw_archives CRUD)
- `src/db/candidate-repository.ts` (candidate_memories CRUD)
- Per-kind store files: wiki / fact-claim / graph CRUD — find via grep
- `src/api/server.ts` + `src/mcp/server.ts` (usage_ack handler only; minimal)
- `src/usage/ack-store.ts` (only if trivial persistence add)
- `src/tests/source-kind-propagation.test.ts` (update + extend)
- `docs/architecture/source-kind-propagation.md` (update Known gaps)

## Forbidden patterns

- NO amend of prior commits — new commit on HEAD (parent = `016e056`)
- ALTER statements MUST be idempotent (re-init safe via try/catch or PRAGMA precheck)
- Postgres path MUST early-return (pattern: `if (db.isPostgres) return;` at top of DDL block)
- Default backfill values MUST match canonical kind for each table (wiki→"wiki", fact_claims→"fact_claim", etc.)
- Insert paths MUST continue to work for callers who don't pass source_kind (default to canonical kind)
- Breaking tests elsewhere MUST be fixed, not masked (no skip / TODO)
- NO enum narrowing via zod in `src/core/contracts/` — source_kind values are strings at DB level, zod guards live at the API/MCP boundary (already in place)

## Acceptance criteria

1. `rg -n "ALTER TABLE.*ADD COLUMN source_kind" src/db/schema.ts` ≥ 6 (one per target table)
2. `rg -n "UPDATE.*SET source_kind" src/db/schema.ts` ≥ 6 (one backfill per table)
3. `rg -n "db.isPostgres" src/db/schema.ts` ≥ 1 (Postgres early-return in DDL block)
4. `rg -nE "source_kind" src/db/repository.ts` ≥ 4 (reads + writes for memories + raw_archives)
5. `rg -nE "source_kind" src/db/candidate-repository.ts` ≥ 2 (candidate insert + read)
6. `rg -nE "source_kind|echoed_source_kinds" src/api/server.ts src/mcp/server.ts` ≥ 2 (usage_ack touches both surfaces)
7. `src/tests/source-kind-propagation.test.ts`: `CURRENT_MISSING_SOURCE_KIND_STORES = \\[\\]` (empty list) — verify via `rg -n "CURRENT_MISSING_SOURCE_KIND_STORES = " src/tests/source-kind-propagation.test.ts`
8. `rg -c "^test\\(" src/tests/source-kind-propagation.test.ts` ≥ 9 (was 6 in 24a; +3 new: backfill, preserve-non-default, usage_ack echo)
9. `docs/architecture/source-kind-propagation.md` Known gaps section states full 6/6 support (`rg -n "6.*stores|all.*support" docs/architecture/source-kind-propagation.md` ≥ 1)
10. `git diff HEAD -- src/backup/ .eslintrc.cjs package.json src/promotion/ src/db/fts-query-escape.ts src/retrieval/ranker-score.ts src/retrieval/ranker.ts src/retrieval/orchestrator.ts src/retrieval/sources/ src/retrieval/profiles.ts src/reconciliation/ src/monitoring/ src/scheduler/ src/notify/ src/sunset/ src/alert/ src/timeout/ src/checkpoint/ src/feature-flags/ src/sdk/ src/index.ts src/core/contracts/intent.ts` outputs empty
11. `set -o pipefail; npm run build` exits 0; `set -o pipefail; npm test` ≥ 1232 pass / 0 fail (1229 + ≥ 3 new)
12. `npm run lint:readonly-guard` exits 0
13. Not-amend; parent of new commit = `016e056`
14. Commit title prefix `feat(source-kind):` OR `fix(source-kind):`
15. Commit body:
    ```
    Close 🟡 P8-029: source_kind schema + usage_ack echo.

    Schema migration:
    - src/db/schema.ts: ALTER TABLE ADD COLUMN source_kind on 6 stores
      (candidate_memories, memories, wiki_pages, fact_claims, relations,
      raw_archives). Idempotent via try/catch; Postgres path early-returns.
    - Backfill UPDATE statements set canonical kind per table for existing
      NULL rows (vega_memory / vega_memory / wiki / fact_claim / graph /
      archive).

    Repository plumbing:
    - repository.ts + candidate-repository.ts + per-kind stores: INSERT
      paths accept source_kind (default to canonical kind), SELECT paths
      return source_kind preserved.

    usage_ack echo:
    - src/api/server.ts + src/mcp/server.ts: ack response echoes the
      unique source_kinds from bundle records under
      echoed_source_kinds[]. Persistence deferred (records still contain
      the field via bundle_digest round-trip).

    Test closure:
    - src/tests/source-kind-propagation.test.ts: CURRENT_MISSING_SOURCE_
      KIND_STORES = []; main >= 4 threshold now truthful. New tests:
      backfill, preserve-non-default on insert, usage_ack echo.
    - docs/architecture/source-kind-propagation.md: Known gaps section
      reflects 6/6 support as of 2026-04-21.

    Closes 🟡 P8-029 end-state. Parent = 016e056.

    Scope-risk: moderate (DB migration on production startup; idempotent
    + backfill is additive; no reads change semantics)
    Reversibility: requires DROP COLUMN (SQLite 3.35+ supports it) OR
    accepting the column stays — data can be rebuilt from source events
    if needed.
    ```

## Review checklist

- ALTER statements wrapped in try/catch (or PRAGMA precheck) for re-init safety?
- All 6 tables actually get the column (grep matches 6, not 5)?
- Backfill defaults match each table's canonical kind (wiki→"wiki", not "vega_memory")?
- Postgres path early-returns from the DDL block?
- Insert paths default correctly when caller omits source_kind?
- `source-kind-propagation.test.ts`: `CURRENT_MISSING_SOURCE_KIND_STORES = []` (flipped)?
- New usage_ack echo test asserts actual echo (not just non-throw)?
- Doc Known gaps updated to reflect 6/6 support?
- `npm run lint:readonly-guard` still exit 0 (no fs writes introduced)?
- New commit stacks on `016e056` (not amend)?

## Commit discipline

- Single atomic commit
- Prefix `feat(source-kind):` OR `fix(source-kind):`
- Body per Acceptance #15
- Files changed: `src/db/schema.ts` + `src/db/repository.ts` + `src/db/candidate-repository.ts` + per-kind store files + `src/api/server.ts` + `src/mcp/server.ts` + `src/tests/source-kind-propagation.test.ts` + `docs/architecture/source-kind-propagation.md`. Possibly `src/usage/ack-store.ts` if ack persistence added.

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
