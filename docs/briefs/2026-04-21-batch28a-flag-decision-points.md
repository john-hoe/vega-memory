# Batch 28a — Close 🟡 P8-020: 3 real flag-gated decision points

## Context

P8-020 framework shipped in 20a (`src/feature-flags/` + zod registry + MCP tools + proof-of-wiring at `/ingest_event` via X-Vega-Canary header). The 🟡 gap: "真正 ingest / retrieval / usage_ack decision point 的 flag 分支还没接" — one proof-of-wiring is not real canary rollout.

This batch wires **3 real decision points** with safe defaults, giving ops a rollback lever for recently-landed Phase 8 features:

1. **`retrieval-queryless-bootstrap`** (default on): gates the B5 queryless bootstrap wide recall. "off" reverts behavior to "empty bundle for empty query" (pre-B5).
2. **`usage-ack-echo-source-kind`** (default on): gates the B6 `echoed_source_kinds[]` response field. "off" omits the echo (for external consumers that don't handle the new field).
3. **`ranker-recency-halflife-14d`** (default off): when "on", switches ranker recency decay from 7-day to 14-day half-life (retention-sensitivity experiment).

Each flag is evaluated at a real runtime decision point. Registry gets 3 entries (currently `flags: []`). Proof-of-wiring at `/ingest_event` stays — this batch adds real gates, doesn't replace.

No amend — new commit on HEAD (parent = `f0e9fce`).

## Scope

### 1. `docs/feature-flags/flags.yaml` — register 3 flags

Replace `flags: []` with the 3 entries:

```yaml
flags:
  - id: retrieval-queryless-bootstrap
    description: Gate the queryless bootstrap wide-recall path. Off reverts to empty-bundle-on-empty-query (pre-B5 behavior).
    variants:
      on: true
      off: false
    default: on
    matchers:
      surfaces: "*"
      intents: ["bootstrap"]
      traffic_percent: 100
    bucketing:
      seed_field: session_id

  - id: usage-ack-echo-source-kind
    description: Gate the echoed_source_kinds[] field in usage.ack response. Off omits the echo (compat for older consumers).
    variants:
      on: true
      off: false
    default: on
    matchers:
      surfaces: "*"
      intents: "*"
      traffic_percent: 100
    bucketing:
      seed_field: session_id

  - id: ranker-recency-halflife-14d
    description: When on, switches ranker recency decay half-life from 7 days to 14 days. Retention-sensitivity canary.
    variants:
      on: true
      off: false
    default: off
    matchers:
      surfaces: "*"
      intents: "*"
      traffic_percent: 0
    bucketing:
      seed_field: session_id
```

### 2. `src/retrieval/profiles.ts` OR bootstrap-dispatching logic — wire flag #1

Wherever the bootstrap profile's queryless branch lives (plumbed through B5 at profile level), evaluate `retrieval-queryless-bootstrap` BEFORE dispatching to `listRecent(...)` fallback:

```ts
import { DEFAULT_FEATURE_FLAG_REGISTRY_PATH, evaluateFeatureFlag, loadFeatureFlagRegistry } from "../feature-flags/index.js";

// In the bootstrap-queryless branch:
const registry = loadFeatureFlagRegistry(DEFAULT_FEATURE_FLAG_REGISTRY_PATH);
const flag = registry.find(({ id }) => id === "retrieval-queryless-bootstrap");
const variant = flag === undefined ? "on" : evaluateFeatureFlag(flag, { surface, intent: "bootstrap", session_id }).variant;

if (variant === "off") {
  return [];  // Revert to pre-B5 behavior
}
// Current queryless wide recall path
return listRecent({ limit });
```

Decision point MUST be at the profile / orchestrator level (before sources are dispatched), not inside each source — DRY.

### 3. `src/api/server.ts` + `src/mcp/server.ts` — wire flag #2 around echoed_source_kinds

In the usage_ack handler where `echoed_source_kinds[]` is assembled (B6 landed this), guard with flag evaluation:

```ts
const flag = registry.find(({ id }) => id === "usage-ack-echo-source-kind");
const variant = flag === undefined ? "on" : evaluateFeatureFlag(flag, { surface, intent: "ack", session_id }).variant;

if (variant === "on") {
  response.echoed_source_kinds = [...uniqueKinds];
}
// else: echo field simply omitted from response
```

Both `src/api/server.ts` and `src/mcp/server.ts` get the guard. Response type stays optional (was likely already optional field).

### 4. `src/retrieval/ranker-score.ts` — wire flag #3

`computeRecency` currently hardcodes `0.693 / 7` (ln2 / 7days). Extract a `halfLifeDays` parameter (default 7). Evaluate flag at the call site:

```ts
// In ranker.ts (or wherever computeRecency is called):
const flag = registry.find(({ id }) => id === "ranker-recency-halflife-14d");
const variant = flag === undefined ? "off" : evaluateFeatureFlag(flag, { surface, intent, session_id }).variant;
const halfLifeDays = variant === "on" ? 14 : 7;
const recency = computeRecency(record.created_at, now, halfLifeDays);
```

`computeRecency` signature becomes `computeRecency(created_at, now, halfLifeDays = 7)`. Default preserves pre-28a behavior.

### 5. Integration tests — prove flags actually gate behavior

New `src/tests/feature-flag-decision-points.test.ts` (new file, ≥ 6 cases):

1. **Flag `retrieval-queryless-bootstrap` default on → queryless bootstrap returns records**: no registry override; seed 3 memories; bootstrap without query; assert `bundle.records.length > 0`.
2. **Flag `retrieval-queryless-bootstrap` off → queryless bootstrap returns empty**: override flag to `default: off, traffic_percent: 0`; same setup; assert `bundle.records.length === 0`.
3. **Flag `usage-ack-echo-source-kind` default on → response has echoed_source_kinds**: call ack with bundle_sections carrying source_kind; assert `response.echoed_source_kinds !== undefined`.
4. **Flag `usage-ack-echo-source-kind` off → response omits echoed_source_kinds**: override flag to off; same call; assert `response.echoed_source_kinds === undefined` (or `=== []`, depending on impl).
5. **Flag `ranker-recency-halflife-14d` default off → 7-day half-life**: seed record with `created_at = now - 7 days`; call ranker; assert `recency ≈ 0.5`.
6. **Flag `ranker-recency-halflife-14d` on → 14-day half-life**: override flag to on + traffic_percent 100; same seed; assert `recency ≈ 0.707` (e^(-ln2*7/14)).

Hermetic: each test writes a temporary `flags.yaml` via `mkdtempSync` and seeds the registry path via constructor / env override. Do NOT touch the real `docs/feature-flags/flags.yaml` from tests.

### 6. Update 20a canary-rollout runbook

`docs/adapters/canary-rollout.md` — if it exists (from 20a), append a "Live decision points" section listing the 3 new flags with their decision sites (`src/retrieval/profiles.ts` / `src/api/server.ts` + `src/mcp/server.ts` / `src/retrieval/ranker-score.ts`).

## Out of scope — do NOT touch

- `src/backup/**`, `.eslintrc.cjs`, `package.json`, `src/promotion/**`, `src/db/fts-query-escape.ts`, `src/db/schema.ts`, `src/db/repository.ts`, `src/db/candidate-repository.ts`, `src/wiki/**` (prior batches sealed)
- `src/reconciliation/**`, `src/monitoring/**`, `src/scheduler/**`, `src/notify/**`, `src/sunset/**`, `src/alert/**`, `src/timeout/**`, `src/checkpoint/**`, `src/sdk/**`
- `src/retrieval/sources/host-memory-file*.ts` (readonly-guarded)
- `src/retrieval/sources/{promoted-memory,wiki,fact-claim,graph,archive}.ts` (already have the queryless path; decision point should be above these)
- `src/feature-flags/registry.ts` / `evaluator.ts` / `bucketing.ts` / `metrics.ts` / `mcp.ts` / `index.ts` / `runtime.ts` (framework is complete; adding flags is registry.yaml level)
- `src/core/contracts/**` (echo field already declared there per B6)
- `src/index.ts`, `src/db/migrations/**`

Allowed:
- `docs/feature-flags/flags.yaml` (add 3 flag entries)
- `src/retrieval/profiles.ts` OR `src/retrieval/orchestrator.ts` (decision point for flag #1)
- `src/retrieval/ranker-score.ts` (half-life parameter)
- `src/retrieval/ranker.ts` (flag evaluation call + param wiring)
- `src/api/server.ts` + `src/mcp/server.ts` (flag #2 guard)
- `docs/adapters/canary-rollout.md` (if exists)
- `src/tests/feature-flag-decision-points.test.ts` (new)

## Forbidden patterns

- Production code MUST NOT sniff test env
- Tests MUST NOT touch real HOME / keychain / user config
- Tests MUST NOT modify the live `docs/feature-flags/flags.yaml` — use tmp registry path
- NO amend of prior commits — new commit on HEAD (parent = `f0e9fce`)
- Flag evaluation MUST handle missing registry / missing flag / parse error gracefully (degraded = default variant); evaluator already does this but don't undermine at call site
- Defaults MUST preserve pre-28a behavior — `retrieval-queryless-bootstrap` default on, `usage-ack-echo-source-kind` default on, `ranker-recency-halflife-14d` default off
- Flag evaluation MUST NOT block critical path on I/O (registry is cached; if not, wrap in fast path)

## Acceptance criteria

1. `rg -nE "retrieval-queryless-bootstrap|usage-ack-echo-source-kind|ranker-recency-halflife-14d" docs/feature-flags/flags.yaml` ≥ 3 (all 3 flags registered)
2. `docs/feature-flags/flags.yaml` contains `flags:\n  - id:` (not `flags: []`)
3. `rg -n "retrieval-queryless-bootstrap" src/retrieval/` ≥ 1 (wired at decision point)
4. `rg -n "usage-ack-echo-source-kind" src/api/server.ts src/mcp/server.ts` ≥ 2 (both surfaces guarded)
5. `rg -n "ranker-recency-halflife-14d" src/retrieval/` ≥ 1 (wired at ranker call site)
6. `rg -nE "halfLifeDays" src/retrieval/ranker-score.ts` ≥ 1 (parameter added)
7. `src/tests/feature-flag-decision-points.test.ts` exists; `rg -c "^test\\(" src/tests/feature-flag-decision-points.test.ts` ≥ 6
8. `git diff HEAD -- src/backup/ src/promotion/ src/db/ src/wiki/ src/reconciliation/ src/monitoring/ src/scheduler/ src/notify/ src/sunset/ src/alert/ src/timeout/ src/checkpoint/ src/sdk/ src/retrieval/sources/host-memory-file-paths.ts src/retrieval/sources/host-memory-file-parser.ts src/retrieval/sources/host-memory-file-fts.ts src/retrieval/sources/host-memory-file-schema-router.ts src/retrieval/sources/host-memory-file.ts src/retrieval/sources/promoted-memory.ts src/retrieval/sources/wiki.ts src/retrieval/sources/fact-claim.ts src/retrieval/sources/graph.ts src/retrieval/sources/archive.ts src/feature-flags/ src/core/contracts/ src/index.ts .eslintrc.cjs package.json` outputs empty
9. `git diff HEAD -- src/tests/` shows only 1 new file `feature-flag-decision-points.test.ts`
10. `set -o pipefail; npm run build` exits 0; `set -o pipefail; npm test` ≥ 1239 pass / 0 fail (1233 + 6 new)
11. `npm run lint:readonly-guard` exits 0
12. Not-amend; parent of new commit = `f0e9fce`
13. Commit title prefix `feat(feature-flags):`
14. Commit body:
    ```
    Close 🟡 P8-020: 3 real flag-gated decision points.

    - docs/feature-flags/flags.yaml: registered 3 flags:
      * retrieval-queryless-bootstrap (default on) — gates B5 queryless
        bootstrap; off reverts to empty-bundle-on-empty-query.
      * usage-ack-echo-source-kind (default on) — gates B6 echoed_source_
        kinds response field; off omits for older-consumer compat.
      * ranker-recency-halflife-14d (default off) — when on, switches
        recency decay from 7d to 14d half-life (retention canary).
    - src/retrieval/profiles.ts (or orchestrator): flag #1 evaluated at
      bootstrap dispatch; off → return [].
    - src/api/server.ts + src/mcp/server.ts: flag #2 guards
      echoed_source_kinds assembly in usage_ack response.
    - src/retrieval/ranker-score.ts + ranker.ts: halfLifeDays parameter
      added (default 7); flag #3 toggles to 14 at ranker call site.
    - New feature-flag-decision-points.test.ts (≥ 6 cases): proves each
      flag actually gates behavior (on path vs off path).
    - docs/adapters/canary-rollout.md: Live decision points appendix
      (if file existed).

    Closes 🟡 P8-020 end-state. Framework was in place from 20a;
    this batch wires real runtime gates.

    Scope-risk: low (all defaults preserve pre-28a behavior;
    off-variants revert to earlier known-good behavior)
    Reversibility: clean (flip flag in registry OR revert commit)
    ```

## Review checklist

- All 3 flags in registry with correct defaults (on/on/off)?
- Decision points are at the right level (profile for bootstrap, handler for ack, ranker for half-life) — not duplicated in each source?
- Each flag has a real on-vs-off behavioral difference tested?
- Defaults preserve current behavior exactly (no surprise regressions)?
- Test uses tmp registry path (not live `docs/feature-flags/flags.yaml`)?
- `npm run lint:readonly-guard` still exit 0?
- New commit stacks on `f0e9fce` (not amend)?

## Commit discipline

- Single atomic commit
- Prefix `feat(feature-flags):`
- Body per Acceptance #14
- Files changed: `docs/feature-flags/flags.yaml` + 1-2 retrieval files + 2 server files + 1 test file + possibly `docs/adapters/canary-rollout.md`
