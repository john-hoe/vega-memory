# Batch 19a — source_kind end-to-end propagation + integration test (P8-029.1-.5 closure)

## Context

P8-029 (Wave 5) validates that `source_kind` propagates losslessly through the full Vega pipeline:

```
host event
  └─ ingest_event handler → raw_inbox.source_kind            (P8-029.1)
       └─ Repository hydration → memories / candidate_memory / wiki / fact_claim / graph / archive stores with source_kind preserved   (P8-029.2)
            └─ Retrieval orchestrator → SourceRecord.source_kind in every bundle entry   (P8-029.3)
                 └─ usage.ack / deep_recall / consolidation pass-through (echoing source_kind back unchanged)   (P8-029.4)
```

The foundation was laid across Waves 1-4 (P8-001 envelope, P8-002.4 enum, P8-007 raw_inbox, P8-010 ingest handler, P8-015/16 retrieval sources). This batch **verifies** the propagation with a comprehensive integration test and **documents** the contract.

**Expected happy path**: the test passes without requiring any production code change — the existing pipeline already propagates `source_kind` correctly. If it fails, the batch ships minimal targeted fixes only on the specific propagation point that drops the field.

## Scope

### 1. `src/tests/source-kind-propagation.test.ts` (new) — end-to-end integration test

Set up a `:memory:` SQLite harness + minimal server wiring (reuse patterns from existing integration tests such as `src/tests/e2e.test.ts`). Use `mkdtempSync` for tmp home.

#### Test A — raw_inbox preserves source_kind (P8-029.1)
- Build a minimal HTTP POST to `/ingest_event` (or call the ingest handler directly if exposed). Payload: envelope with `source_kind: "host_memory_file"` + other realistic fields.
- After call completes: SELECT `source_kind` FROM `raw_inbox` WHERE `event_id = ?` — assert equal to `"host_memory_file"`.
- Repeat with `source_kind: "vega_memory"` + `source_kind: "wiki"` — assert each persists verbatim.

#### Test B — storage layers preserve source_kind (P8-029.2)
- For each of the 6 storage types (candidate_memory / promoted memories / wiki / fact_claim / graph / archive), call the repository factory to hydrate a record with `source_kind: "host_memory_file"`.
- Assert that after SELECT, `source_kind` column matches input.
- If a given store does NOT have a `source_kind` column today (check schema first), skip with an explicit `TODO` comment + log a warn (don't fail the test). Emit a test-level counter of "stores supporting source_kind" — must be ≥ 4 (allow 2 missing; anything worse → hard fail with detailed message).

#### Test C — retrieval bundle carries source_kind (P8-029.3)
- Seed a `memories` row with `source_kind: "host_memory_file"`, then invoke the retrieval orchestrator (`resolveContext(...)` or equivalent) with an intent that includes the `vega_memory` + `host_memory_file` profile.
- Assert every `bundle.records[i].source_kind` is non-null and matches the seeded value for the hits.

#### Test D — usage.ack echoes source_kind (P8-029.4)
- After a retrieval call (Test C), capture the `checkpoint_id` and bundle record IDs.
- Call `usage_ack` handler with `sufficiency: "sufficient"` + echo the bundle records.
- Assert the handler does NOT error; if `source_kind` round-trips through ack (echoed in a receipt / stored in any `usage_ack` table), assert equality. If not echoed (handler just accepts), at minimum assert handler accepts the input without stripping the field.

#### Test E — full chain test (P8-029.5)
- Orchestrate A+B+C+D in one flow: ingest → retrieve → ack. One `event_id`, one `source_kind: "host_memory_file"`. Assert the value surfaces unchanged at every checkpoint table / response shape.

Use `assert.equal(received.source_kind, "host_memory_file")` style assertions (strict equal). Each test case is self-contained (no cross-test state).

### 2. `docs/architecture/source-kind-propagation.md` (new)

Required section headings (grep-checkable):
1. `## Invariant` — statement: `source_kind` assigned at ingest is preserved losslessly through every store and every retrieval surface.
2. `## Propagation path` — diagram-style listing of the 4 waypoints (ingest → raw_inbox → store → bundle → ack).
3. `## Canonical values` — list or link to the `source_kind` enum (P8-002.4): `host_memory_file`, `vega_memory`, `wiki`, `fact_claim`, `graph`, `archive`, + any others.
4. `## Known gaps` — enumerate stores or handlers where `source_kind` is not yet preserved (if any). If Test B's skip-list is non-empty, listed here with TODOs for follow-up batch.
5. `## Testing` — reference to `src/tests/source-kind-propagation.test.ts`.

### 3. Minimal fixes IF tests fail

If Test B / C / D reveals that a specific layer drops `source_kind`, codex may apply targeted fixes to make that layer preserve it. Constraints on such fixes:

- Must be localized to the failing propagation point (1 file typically).
- Must NOT touch any of the forbidden-path list below.
- Must document the change in this batch's commit body under a separate section `## Production fixes applied (if any)`.
- If fix would require touching a forbidden file: DO NOT fix in this batch. Skip the failing assertion with a TODO, list in `## Known gaps` doc, and file a follow-up batch 19a.1 with its own brief. Commit body explicitly calls out the skipped assertion.

Forbidden paths this batch CANNOT touch:
- `src/reconciliation/**`, `src/monitoring/vega-metrics.ts`, `metrics-fingerprint.ts`, `metrics.ts`, `dashboards/**`
- `src/scheduler/**`, `src/notify/**`, `src/sunset/**`, `src/alert/**`, `src/backup/**`, `src/timeout/**`
- `src/retrieval/sources/host-memory-file*.ts` (12a/12b/17a/18a sealed)
- `.eslintrc.cjs` (17a sealed)
- `src/db/migrations/**`, `src/core/contracts/**`

Paths that MAY be edited if strictly necessary (minimal localized change, documented in commit body):
- `src/api/server.ts` (ingest / ack / retrieval endpoints wiring)
- `src/mcp/server.ts` (same, MCP surface)
- `src/retrieval/orchestrator.ts` or `src/retrieval/ranker-score.ts` or `src/retrieval/profiles.ts` (bundle hydration)
- `src/db/repository.ts` or per-store files under `src/candidate/` / `src/wiki/` / `src/fact_claim/` / `src/graph/` / `src/archive/` (store hydration)
- Existing ingest handler file (wherever source_kind is assigned)

Default expectation: zero fixes needed. Test file is the primary artifact.

## Forbidden patterns

- Production code MUST NOT sniff test environment
- Tests MUST NOT touch real HOME / keychain / user config
- NO amend of 2d7a862 / 30884bc
- Tests MUST use `:memory:` SQLite + `mkdtempSync` for tmp dirs
- Every test case MUST start from a fresh DB (no cross-test state)

## Acceptance criteria

1. `src/tests/source-kind-propagation.test.ts` exists; `rg -c "^test\(" src/tests/source-kind-propagation.test.ts` ≥ 5 (one per Test A/B/C/D/E)
2. `docs/architecture/source-kind-propagation.md` exists with 5 section headings (each ≥ 1 match)
3. `git diff HEAD -- src/reconciliation/ src/monitoring/vega-metrics.ts src/monitoring/metrics-fingerprint.ts src/monitoring/metrics.ts dashboards/ src/scheduler/ src/notify/ src/sunset/ src/alert/ src/backup/ src/timeout/ src/retrieval/sources/host-memory-file-paths.ts src/retrieval/sources/host-memory-file-parser.ts src/retrieval/sources/host-memory-file-fts.ts src/retrieval/sources/host-memory-file-schema-router.ts src/retrieval/sources/host-memory-file.ts .eslintrc.cjs src/db/migrations/ src/core/contracts/` outputs empty
4. `git diff HEAD -- src/tests/` shows only 1 new `source-kind-propagation.test.ts`
5. `set -o pipefail; npm run build` exits 0; `set -o pipefail; npm test` ≥ 1160 pass / 0 fail (1155 + ≥ 5 new)
6. If ANY production fix was applied, commit body's `## Production fixes applied` section documents each with file:line + why
7. Not-amend; new commit on HEAD
8. Commit title prefix `test(integration):` if NO production fix, OR `feat(source-kind):` if production fix was applied
9. Commit body:
    ```
    Validates source_kind end-to-end propagation P8-029.1-.5:
    - src/tests/source-kind-propagation.test.ts: ≥ 5 cases covering
      raw_inbox preservation, store hydration across 6 store types
      (candidate / promoted / wiki / fact_claim / graph / archive),
      retrieval bundle source_kind, usage.ack echo, and one end-to-end
      chain test.
    - docs/architecture/source-kind-propagation.md: invariant / path /
      canonical values / known gaps / testing reference.

    ## Production fixes applied (if any)
    [List each: file:line — reason. Otherwise write "None; existing
    pipeline already propagates source_kind correctly."]

    ## Known gaps
    [List stores/handlers that drop source_kind and were skipped with
    TODO in the test, OR write "None."]

    Scope: zero touches to reconciliation / monitoring / scheduler /
    notify / sunset / alert / backup / timeout / host-memory-file /
    eslint / migrations / contracts.

    Scope-risk: low (test-only in the default case)
    Reversibility: clean
    ```

## Review checklist

- Is the test hermetic (`:memory:` + mkdtempSync)?
- Do Test A/B/C/D/E each start from fresh DB (no cross-test pollution)?
- For Test B: if 6 stores tested, is the skip-list (if any) both logged AND documented in the "Known gaps" doc + commit body?
- If production fixes applied: are they localized to 1-2 files max, in allowed paths?
- Does `docs/architecture/source-kind-propagation.md` accurately reflect current gaps (if any)?
- Is the commit title prefix correct (`test(integration):` vs `feat(source-kind):` based on whether code changed)?
- New commit stacks on `30884bc` (not an amend)?

## Commit discipline

- Single atomic commit, new stack on HEAD
- Title prefix based on whether any production code changed
- Body per Acceptance #9
- No root-level markdown; only allowed new doc is `docs/architecture/source-kind-propagation.md`
