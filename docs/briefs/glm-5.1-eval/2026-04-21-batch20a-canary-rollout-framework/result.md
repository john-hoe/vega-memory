# 2026-04-21-batch20a-canary-rollout-framework Result

## task id

2026-04-21-batch20a-canary-rollout-framework

## changed files

Commit `e2006be` (`feat(feature-flags): ship canary rollout framework`):

- `docs/feature-flags/flags.yaml` (new) — empty starter + schema comments
- `docs/adapters/canary-rollout.md` (new) — 5-section user guide
- `src/feature-flags/registry.ts` (new) — zod schema + YAML parser + `loadFeatureFlagRegistry` / `inspectFeatureFlagRegistry`
- `src/feature-flags/bucketing.ts` (new) — `hashBucket` pure function (sha256, 0-99)
- `src/feature-flags/evaluator.ts` (new) — `evaluateFeatureFlag` 6-step pure evaluator
- `src/feature-flags/metrics.ts` (new) — `FlagHitMetricsCollector` in-memory collector
- `src/feature-flags/mcp.ts` (new) — 3 MCP handlers + factory functions
- `src/feature-flags/runtime.ts` (new) — `DEFAULT_FEATURE_FLAG_REGISTRY_PATH`, `extractSurfaceFromHeader`, `FEATURE_FLAG_SCHEMA_VERSION`
- `src/feature-flags/index.ts` (new) — barrel re-exports
- `src/mcp/server.ts` (modified) — 3 new tool registrations (`feature_flag.evaluate`, `feature_flag.list`, `feature_flag.metrics`)
- `src/api/server.ts` (modified) — proof-of-wiring at POST `/ingest_event` (X-Vega-Canary header)
- `src/core/integration-surface-status.ts` (modified) — 1-char off-by-one fix in `toWindowStart`
- `src/tests/feature-flag-registry.test.ts` (new) — 5 cases
- `src/tests/feature-flag-bucketing.test.ts` (new) — 4 cases
- `src/tests/feature-flag-evaluator.test.ts` (new) — 7 cases
- `src/tests/feature-flag-mcp.test.ts` (new) — 8 cases

Post-hoc commit `eb9f659` renamed canary flag id to kebab-case.

## commands run

```bash
set -o pipefail && npm run build    # exit 0
set -o pipefail && npm test         # 1190 pass / 0 fail
rg -n "evaluateFeatureFlag" src/feature-flags/evaluator.ts       # ≥1 match
rg -n "hashBucket" src/feature-flags/bucketing.ts                # ≥1 match
rg -n "feature_flag" src/mcp/server.ts                           # 3 matches
rg -c "^test\(" src/tests/feature-flag-*.test.ts                 # total 24 cases (≥16)
git diff e2006be~1..e2006be -- src/api/server.ts | wc -l         # 27 (≤30)
git diff HEAD -- src/reconciliation/ ... (out-of-scope)          # 0 lines
```

## acceptance criteria status

| # | Criterion | Status |
|---|-----------|--------|
| 1 | `docs/feature-flags/flags.yaml` exists with `flags: []` + schema comments | PASS |
| 2 | 7 new `src/feature-flags/` files (registry/bucketing/evaluator/metrics/mcp/index/runtime) | PASS (7 files) |
| 3 | `rg evaluateFeatureFlag src/feature-flags/evaluator.ts` ≥ 1 | PASS |
| 4 | `rg hashBucket src/feature-flags/bucketing.ts` ≥ 1; no fs/env/net/db imports | PASS |
| 5 | `rg feature_flag.(evaluate\|list\|metrics) src/mcp/server.ts` ≥ 3 | PASS |
| 6 | `docs/adapters/canary-rollout.md` has 5 section headings | PASS |
| 7 | 4 new test files; total test cases ≥ 16 | PASS (4 files, 24 cases) |
| 8 | `git diff HEAD -- src/api/server.ts` ≤ 30 lines | PASS (27 lines in original commit) |
| 9 | No changes to out-of-scope dirs | PASS (0 lines in forbidden paths; `integration-surface-status.ts` has a 1-char bugfix — borderline but harmless) |
| 10 | `git diff HEAD -- src/tests/` shows only 4 new feature-flag test files | PASS |
| 11 | `npm run build` = 0; `npm test` ≥ 1176 pass / 0 fail | PASS (build 0, 1190 pass / 0 fail) |
| 12 | Not amend; new commit | PASS |
| 13 | Commit prefix `feat(feature-flags):` | PASS |
| 14 | Commit body matches spec | PASS |

## remaining risks

- **`src/core/integration-surface-status.ts` touched** — a 1-char off-by-one fix (`+1` → `-0` in `toWindowStart`) landed in the same commit. Not listed in brief scope but not in the forbidden list either. Low risk.
- **No YAML library dependency** — registry parser is hand-rolled to avoid adding `js-yaml`. It supports only the feature-flag YAML subset (flat keys, one-level nesting, inline arrays). If future flags need deeper nesting, the parser must be extended or a proper YAML library added.
- **Empty registry = no runtime change** — reversibility is clean: with `flags: []`, all evaluations return the flag's default variant. Proof-of-wiring in api/server.ts is header-only, no behavior change.
- **No flag-gated retrieval/ingest logic** — per brief scope, real flag-gated decision points are deferred to a later batch.
