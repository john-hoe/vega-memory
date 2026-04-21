# Batch 20a — Canary rollout feature-flag framework (P8-020.1-.6 closure)

## Context

P8-020 (Wave 5) ships canary rollout: feature flags that gate behavior on three dimensions — `surface` × `intent` × `traffic_percent`. Mirror the framework pattern from sunset / alert / backup: greenfield `src/feature-flags/` module + YAML registry + MCP tool + metrics hook + docs.

**Single-flag runtime evaluation is the library's job; wiring into specific decision points** (retrieval orchestrator / ingest handler / etc.) is **deferred to a later batch** — this batch ships the framework + 1 proof-of-wiring example in an already-allowed file.

## Scope

### 1. `docs/feature-flags/flags.yaml` (new) — registry starter

```yaml
# Vega feature flag registry (P8-020). Each flag gates one variant with a
# per-dimension match: surface × intent × traffic_percent.
#
# Schema (zod-enforced in src/feature-flags/registry.ts):
#   - id: kebab-case
#   - description: short human-readable
#   - variants: { on: <any serializable>, off: <any serializable> }
#   - default: "on" | "off"
#   - matchers:
#       surfaces: [string] | "*"     # "*" = any
#       intents: [string] | "*"
#       traffic_percent: 0-100        # 0 = all-off; 100 = all-on (within matchers)
#   - bucketing:
#       seed_field: "session_id" | "project" | "surface"  # default session_id
#
flags: []
```

### 2. `src/feature-flags/registry.ts` (new)

- zod `FeatureFlagSchema` for the above.
- `loadFeatureFlagRegistry(path, { env? }): FeatureFlag[]` — missing file / parse error → `[]` + warn log (never throws). Supports `${VAR}` env expansion.
- Default empty registry = all flags evaluate as `default`.

### 3. `src/feature-flags/bucketing.ts` (new) — deterministic traffic bucketing

- `hashBucket(seed: string, flag_id: string): number` — returns integer 0-99. Deterministic sha256-based: `sha256(seed + ":" + flag_id)` → take first 4 bytes, modulo 100.
- Pure function. Same seed + flag_id → same bucket forever.

### 4. `src/feature-flags/evaluator.ts` (new) — runtime evaluation

- `EvaluationContext = { surface?: string; intent?: string; session_id?: string; project?: string }`
- `evaluateFeatureFlag(flag: FeatureFlag, ctx: EvaluationContext): { variant: "on" | "off"; reason: string }`:
  1. Match surfaces (matchers.surfaces === "*" OR contains ctx.surface).
  2. Match intents (same).
  3. If neither matches: return `{ variant: flag.default, reason: "matcher_miss" }`.
  4. If traffic_percent === 0: `{ variant: "off", reason: "traffic_0" }`.
  5. If traffic_percent === 100: `{ variant: "on", reason: "traffic_100" }`.
  6. Else compute `bucket = hashBucket(ctx[flag.bucketing.seed_field] || "default", flag.id)`. Variant = bucket < traffic_percent ? "on" : "off". reason: `"bucket_${bucket}_<threshold>"`.
- Pure function; no DB / network / env reads.

### 5. `src/feature-flags/metrics.ts` (new) — hit counter

- Self-managed in-memory `FlagHitMetricsCollector`:
  - `record(flag_id, variant, reason)`
  - `snapshot(): { [flag_id]: { on_count, off_count, reasons: {[reason]: count} } }`
  - `reset()`
- Injected into evaluator for optional instrumentation. Consumer (MCP tool) reads snapshot for observability.

### 6. `src/feature-flags/mcp.ts` (new) — MCP tool helpers

- `evaluateFlagHandler(db, registryPath, metrics, { flag_id, context }): { schema_version, variant, reason, hit_count }`
- `listFlagsHandler(db, registryPath): { schema_version, flags: [{id, description, default, matchers}], degraded?: "registry_missing" | "parse_error" }`
- `flagMetricsHandler(metrics): { schema_version, snapshot }`
- All never throw; degraded paths return structured fallbacks.

### 7. `src/feature-flags/index.ts` (new, barrel)

Re-export all.

### 8. `src/mcp/server.ts` — register 3 MCP tools

- `feature_flag.evaluate` (zod input `{ flag_id, context: { surface?, intent?, session_id?, project? } }`)
- `feature_flag.list` (no input)
- `feature_flag.metrics` (no input)

ONE block of 3 additions; zero touches to other tool registrations.

### 9. Proof-of-wiring example — `src/api/server.ts`

Evaluate the hypothetical flag `canary.api-ingest-v2` at the start of POST `/ingest_event` handler. If `variant === "on"` → set a response header `X-Vega-Canary: api-ingest-v2-on`, otherwise `off`. Use default ctx `{ surface: extractSurfaceFromHeader(req) || "unknown", intent: "ingest" }`.

This is a **single 3-5 line addition**, scoped to proving the library integrates cleanly. Real flag-gated production code paths land in a separate future batch.

### 10. `docs/adapters/canary-rollout.md` (new) — user guide

Required section headings (grep-checkable):
1. `## Flag registry format` — YAML schema reference + 2 concrete example flags (one 10%-traffic, one surface-scoped).
2. `## Evaluation semantics` — the 6 steps of `evaluateFeatureFlag`.
3. `## Deterministic bucketing` — `hashBucket` spec; why `session_id`-keyed gives stable per-user rollout.
4. `## Adding a new flag` — 4-step runbook (add to YAML → deploy → call `feature_flag.evaluate` → observe via `feature_flag.metrics`).
5. `## Sunset and retirement` — how a flag gets retired (set default to "on" / remove matcher). Cross-link to P8-033 sunset framework.

### 11. Tests (4 new files, ≥ 16 cases)

- **`src/tests/feature-flag-registry.test.ts`** — ≥ 4: valid load / schema error / file missing / env expansion.
- **`src/tests/feature-flag-bucketing.test.ts`** — ≥ 3: deterministic (same input → same bucket) / different seeds → different buckets / bucket distribution (100 seeds → ~uniform in 0-99).
- **`src/tests/feature-flag-evaluator.test.ts`** — ≥ 6: matcher hit / matcher miss (default) / traffic=0 / traffic=100 / traffic=50 bucketing / seed_field override.
- **`src/tests/feature-flag-mcp.test.ts`** — ≥ 3: evaluate handler happy + registry missing (degraded) / list handler / metrics handler.

All hermetic: `mkdtempSync` tmp dir, `:memory:` SQLite where needed (registry uses plain file).

## Out of scope — do NOT touch

- `src/reconciliation/**`, `src/monitoring/vega-metrics.ts`, `metrics-fingerprint.ts`, `metrics.ts`, `dashboards/**`
- `src/scheduler/**`, `src/notify/**`, `src/sunset/**`, `src/alert/**`, `src/backup/**`, `src/timeout/**`, `src/checkpoint/**`
- `src/retrieval/**` (no flag-gated retrieval evaluation in this batch; deferred)
- `src/api/server.ts` EXCEPT the single proof-of-wiring 3-5 line addition at ingest handler start
- `src/mcp/server.ts` EXCEPT the single 3-tool-registration block
- `.eslintrc.cjs`, `src/db/migrations/**`, `src/core/contracts/**`
- All existing tests (only 4 new feature-flag-*.test.ts files allowed)

## Forbidden patterns

- Production code MUST NOT sniff test env
- Tests MUST NOT touch real HOME / keychain / user config
- NO amend of 730ca92 / 9e22b4d; new commit on HEAD
- Evaluator + bucketing are PURE functions (no DB / env / net / disk)
- MCP handlers never throw; degraded fallback shapes always returned
- Proof-of-wiring addition in api/server.ts must be strictly ≤ 10 lines total

## Acceptance criteria

1. `docs/feature-flags/flags.yaml` exists with `flags: []` + schema comments
2. 7 new src/feature-flags files: registry / bucketing / evaluator / metrics / mcp / index (and one more if needed)
3. `rg -nE "evaluateFeatureFlag" src/feature-flags/evaluator.ts` ≥ 1
4. `rg -nE "hashBucket" src/feature-flags/bucketing.ts` ≥ 1; bucketing.ts has NO fs / env / net / db imports
5. `rg -nE "feature_flag\.(evaluate|list|metrics)" src/mcp/server.ts` ≥ 3
6. `docs/adapters/canary-rollout.md` has 5 section headings
7. 4 new test files; `rg -c "^test\(" src/tests/feature-flag-*.test.ts` total ≥ 16
8. `git diff HEAD -- src/api/server.ts | wc -l` ≤ 30 (proof-of-wiring is tiny)
9. `git diff HEAD -- src/reconciliation/ src/monitoring/vega-metrics.ts src/monitoring/metrics-fingerprint.ts src/monitoring/metrics.ts dashboards/ src/scheduler/ src/notify/ src/sunset/ src/alert/ src/backup/ src/timeout/ src/checkpoint/ src/retrieval/ src/db/migrations/ src/core/contracts/ .eslintrc.cjs` empty
10. `git diff HEAD -- src/tests/` shows only 4 new `feature-flag-*.test.ts` files
11. `set -o pipefail; npm run build` 0; `set -o pipefail; npm test` ≥ 1176 pass / 0 fail
12. Not amend; new commit
13. Commit title prefix `feat(feature-flags):`
14. Commit body:
    ```
    Ships canary rollout feature-flag framework P8-020.1-.6:
    - docs/feature-flags/flags.yaml (empty starter + schema comments)
    - src/feature-flags/{registry,bucketing,evaluator,metrics,mcp,index}.ts:
      zod-validated YAML registry, deterministic sha256-based bucketing
      (hashBucket: pure function, same seed+flag_id → same 0-99 bucket
      forever), 6-step evaluator (matchers → traffic_percent → bucket
      comparison, all pure, no I/O), in-memory metrics collector with
      snapshot/reset, 3 MCP handlers (never-throw, degraded paths).
    - src/mcp/server.ts: 3 new tools feature_flag.evaluate / .list /
      .metrics. Zero touches to other tools.
    - src/api/server.ts: single proof-of-wiring at /ingest_event start —
      evaluates hypothetical `canary.api-ingest-v2`, sets X-Vega-Canary
      response header. ≤ 10 lines.
    - docs/adapters/canary-rollout.md: registry format / evaluation
      semantics / deterministic bucketing / adding a new flag / sunset &
      retirement.
    - 4 new feature-flag-*.test.ts files with ≥ 16 hermetic cases
      covering schema errors, bucketing determinism + distribution,
      matcher branches, and MCP degraded paths.

    Scope: evaluator + bucketing PURE; zero flag-gated retrieval /
    ingest handler logic shipped here. Broader wiring is deferred to a
    later batch.

    Scope-risk: low
    Reversibility: clean (empty registry = all default = no runtime change)
    ```

## Review checklist

- Is evaluator pure (no DB / env / disk)?
- Does hashBucket return stable values across runs for same input?
- Does proof-of-wiring in api/server.ts stay ≤ 10 lines?
- Are the 3 MCP tools registered once each?
- Does flags.yaml starter have `flags: []` AND schema-doc comments?
- New commit stacks on `9e22b4d` (not amend)?

## Commit discipline

- Single atomic commit, new stack on HEAD
- Prefix `feat(feature-flags):`
- Body per Acceptance #14
- No root-level markdown; only new docs: `docs/feature-flags/flags.yaml` + `docs/adapters/canary-rollout.md`
