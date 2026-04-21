# Batch 32a — Close #45: Wave 6 enum contracts convergence

## Context

Issue #45 (label `wave-6`). `src/monitoring/vega-metrics.ts` still declares 3 runtime `as const` arrays locally:
- `RETRIEVAL_INTENTS` (bootstrap/lookup/followup/evidence)
- `SUFFICIENCY` (sufficient/needs_followup/needs_external) — **duplicated** from `src/core/contracts/enums.ts:37`
- `HOST_TIER` (T1/T2/T3) — name mismatch: enums.ts uses `HOST_TIERS` (plural)

Canonical source for metric labels should live in `src/core/contracts/`. Drift risk: if canonical list changes, metric layer silently coerces new values to "unknown".

Fix:
1. Add `RETRIEVAL_INTENTS` + derived type to `src/core/contracts/enums.ts`
2. Rename convergence: metrics.ts should import `SUFFICIENCY` and `HOST_TIERS` (plural, matching enums.ts convention) and `RETRIEVAL_INTENTS`
3. Delete local `SUFFICIENCY` / `HOST_TIER` declarations in metrics.ts
4. Verify drift test (if any exists) still passes

No amend — new commit on HEAD (parent = `b35dbdb`).

## Scope

### 1. `src/core/contracts/enums.ts` — add RETRIEVAL_INTENTS

```ts
export const RETRIEVAL_INTENTS = ["bootstrap", "lookup", "followup", "evidence"] as const;
export type RetrievalIntent = (typeof RETRIEVAL_INTENTS)[number];
```

Place near existing `HOST_TIERS` / `SUFFICIENCY` for consistency.

### 2. `src/monitoring/vega-metrics.ts` — replace local declarations with imports

Before (lines ~33-36):
```ts
export const RETRIEVAL_INTENTS = ["bootstrap", "lookup", "followup", "evidence"] as const;
export const SUFFICIENCY = ["sufficient", "needs_followup", "needs_external"] as const;
export const HOST_TIER = ["T1", "T2", "T3"] as const;
```

After:
```ts
import { RETRIEVAL_INTENTS, SUFFICIENCY, HOST_TIERS } from "../core/contracts/enums.js";

// Re-export for consumers that currently import from vega-metrics.ts
export { RETRIEVAL_INTENTS, SUFFICIENCY, HOST_TIERS } from "../core/contracts/enums.js";

// Keep HOST_TIER as alias if consumers still use singular name (for backward compat)
export const HOST_TIER = HOST_TIERS;
```

**Wait** — simpler: if no external consumer relies on `HOST_TIER` (singular) exported from vega-metrics.ts, just delete the singular form and use `HOST_TIERS` everywhere in metrics.ts. Check via `rg -n "from.*vega-metrics.*HOST_TIER" src/` first. If ≤ 1 consumer, rename locally in that consumer too.

Otherwise add a type-safe alias `export const HOST_TIER = HOST_TIERS` for compat.

### 3. Internal consumers — find and update if needed

`rg -n "HOST_TIER" src/monitoring/vega-metrics.ts` — if used multiple places in the file referencing the singular name, update to `HOST_TIERS`.

`rg -n "from.*vega-metrics.*(RETRIEVAL_INTENTS|SUFFICIENCY|HOST_TIER)" src/` — if external consumers exist, update their imports to point at enums.ts OR keep vega-metrics.ts re-export working.

Prefer re-export to minimize consumer diff. Keep the scope tight.

### 4. Drift test update (if exists)

Look for any existing test asserting enum values haven't drifted (CIRCUIT_BREAKER_STATES pattern — per #45 context). If such test exists for RETRIEVAL_INTENTS/SUFFICIENCY/HOST_TIER(S), verify it still passes with imported arrays.

If no drift test exists today, add minimal one in `src/tests/contracts-enum-sync.test.ts` (new file, 1 test):

```ts
import test from "node:test";
import assert from "node:assert";
import { RETRIEVAL_INTENTS, SUFFICIENCY, HOST_TIERS } from "../core/contracts/enums.js";

test("vega-metrics re-exports match core/contracts/enums canonical values", async () => {
  const metricsModule = await import("../monitoring/vega-metrics.js");
  assert.deepEqual([...metricsModule.RETRIEVAL_INTENTS], [...RETRIEVAL_INTENTS]);
  assert.deepEqual([...metricsModule.SUFFICIENCY], [...SUFFICIENCY]);
  assert.deepEqual([...metricsModule.HOST_TIERS], [...HOST_TIERS]);
});
```

## Out of scope — do NOT touch

- Everything outside these 3 files: `src/core/contracts/enums.ts` + `src/monitoring/vega-metrics.ts` + optional new test file
- `src/core/contracts/usage-ack.ts` (already imports from enums.ts correctly)
- `src/retrieval/profiles.ts` (if it has inline string literals, leave them — not this batch's concern; the canonical array now lives in enums.ts and profiles.ts is already consistent with those values)
- All prior sealed modules
- `.eslintrc.cjs`, `package.json`

Allowed:
- `src/core/contracts/enums.ts` (add RETRIEVAL_INTENTS)
- `src/monitoring/vega-metrics.ts` (replace local with import + re-export)
- `src/tests/contracts-enum-sync.test.ts` (new)
- Potentially 1-2 internal consumer files if `HOST_TIER` naming mismatch forces a local fix

## Forbidden patterns

- NO amend of prior commits — new commit on HEAD (parent = `b35dbdb`)
- NO new enum values introduced — just converge location
- NO breaking consumer API — use re-export for backward compat if external consumers exist
- Drift test MUST compare by value (`deepEqual`), not just reference identity

## Acceptance criteria

1. `rg -n "RETRIEVAL_INTENTS" src/core/contracts/enums.ts` ≥ 1 (canonical export)
2. `rg -n 'from "../core/contracts/enums' src/monitoring/vega-metrics.ts` ≥ 1 (import present)
3. `rg -nE "^export const (RETRIEVAL_INTENTS|SUFFICIENCY|HOST_TIER) = \\[" src/monitoring/vega-metrics.ts` = 0 (local declarations removed)
4. `src/tests/contracts-enum-sync.test.ts` exists (or existing drift test covers the new import); `rg -c "^test\\(" src/tests/contracts-enum-sync.test.ts` ≥ 1
5. No consumer broken: `rg -n "HOST_TIER|SUFFICIENCY|RETRIEVAL_INTENTS" src/` resolves to enums.ts OR vega-metrics.ts re-exports (no dangling imports)
6. `git diff HEAD -- src/` limited to `src/core/contracts/enums.ts` + `src/monitoring/vega-metrics.ts` (+ 1-2 minor consumer fixes if needed) + new `src/tests/contracts-enum-sync.test.ts`
7. `git diff HEAD -- src/tests/` shows only 1 new file (or no change if existing drift test covers)
8. `set -o pipefail; npm run build` exits 0; `set -o pipefail; npm test` ≥ 1256 pass / 0 fail (1255 + ≥ 1 new)
9. `npm run lint:readonly-guard` exits 0
10. Not-amend; parent of new commit = `b35dbdb`
11. Commit title prefix `refactor(contracts):`
12. Commit body:
    ```
    Close #45: converge Wave 6 enum contracts to core/contracts/enums.ts.

    - src/core/contracts/enums.ts: added RETRIEVAL_INTENTS + RetrievalIntent
      as canonical exports (SUFFICIENCY + HOST_TIERS already present).
    - src/monitoring/vega-metrics.ts: replaced local declarations with
      imports from core/contracts/enums.ts. Re-exports maintained for
      backward compat of existing consumers.
    - src/tests/contracts-enum-sync.test.ts: new drift test asserting
      vega-metrics re-exports match enums.ts canonical arrays. Any
      future drift between metric layer and canonical enum fails
      the test.

    Scope: 2 production files + 1 new test. Zero behavior change —
    same values, canonical location.

    Scope-risk: minimal
    Reversibility: clean
    ```

## Review checklist

- Canonical location is `src/core/contracts/enums.ts`, not `vega-metrics.ts`?
- Local declarations in vega-metrics.ts removed, only imports + re-exports left?
- Drift test exists and compares by value (`deepEqual`)?
- `HOST_TIER` naming: either aliased to `HOST_TIERS` OR renamed throughout?
- No consumer broken?
- New commit stacks on `b35dbdb` (not amend)?

## Commit discipline

- Single atomic commit
- Prefix `refactor(contracts):`
- Body per Acceptance #12
