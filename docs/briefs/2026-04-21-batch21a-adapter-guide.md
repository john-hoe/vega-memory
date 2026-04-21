# Batch 21a — Adapter guide + SDK + example integrations (P8-041.1-.6 closure)

## Context

P8-041 (Wave 5, final batch) ships the host-integration documentation suite: minimal TypeScript SDK skeleton, surface registration guide, 3 example integrations (Claude Code / Cursor / OpenCode), troubleshooting guide, example repo pattern, legacy→new migration guide. This is a documentation-heavy batch — no deep production code changes.

## Scope

### 1. `src/sdk/vega-client.ts` (new) — minimal TypeScript SDK skeleton

Thin wrapper around HTTP calls (ingest_event, context_resolve, usage_ack):
- `class VegaClient { constructor({baseUrl, apiKey?}) }`
- Methods: `ingestEvent(payload)`, `contextResolve(payload)`, `usageAck(payload)`
- Uses `globalThis.fetch`; retries 3x on 5xx/network; throws on 4xx with structured error.
- Exports TypeScript types for the 3 request/response shapes (re-exported from existing contracts where possible).
- ≤ 150 lines.

### 2. `src/sdk/index.ts` (new, barrel) — re-exports

### 3. `docs/guides/host-integration/README.md` (new)

Required section headings:
1. `## Quick start` — 5-line "npm install + construct VegaClient + call ingestEvent" walkthrough.
2. `## Surface registration` — how a host declares `host_tier` (T1/T2/T3) + what it affects downstream.
3. `## Example integrations` — links to 3 sub-docs below.
4. `## API reference` — pointer to the 3 main endpoints + their contracts.

### 4. `docs/guides/host-integration/claude-code.md` (new) — Claude Code integration

Required sections:
1. `## Architecture` — how Claude Code slots Vega (data flow diagram: Claude → MCP server → VegaClient → ingest_event).
2. `## Installation` — npm / MCP server config snippet.
3. `## Event mapping` — Claude events (tool calls, messages) → Vega envelope fields.
4. `## Host tier` — Claude declares T1 (real-time user-facing).

### 5. `docs/guides/host-integration/cursor.md` (new) — Cursor integration

Same 4 section pattern as claude-code.md, tailored to Cursor's plugin model.

### 6. `docs/guides/host-integration/opencode.md` (new) — OpenCode integration

Same 4 section pattern, tailored to OpenCode's backend agent model.

### 7. `docs/guides/host-integration/troubleshooting.md` (new)

Required section headings:
1. `## Common errors` — table: error code / cause / fix (5+ rows).
2. `## Observability` — how to query metrics + reconciliation findings + alert history when debugging.
3. `## Retrieval returns no records` — debugging recipe.
4. `## Ingest rejects envelope` — debugging recipe.
5. `## When to contact the Vega team` — escalation path.

### 8. `docs/guides/host-integration/migration.md` (new) — legacy → new migration

Required sections:
1. `## Deprecated APIs` — list + deprecation dates + replacements.
2. `## Step-by-step migration` — 5-step runbook.
3. `## Compatibility window` — how long legacy APIs remain + link to sunset registry (P8-033).
4. `## Validation` — how to verify migration succeeded (reconciliation dims + metrics + alerts).

### 9. `docs/examples/` (new directory) — minimal example repo stub

- `README.md`: explains this is the canonical example integration repo; point to 3 sub-examples below.
- `claude-code-example/README.md`: code-free blueprint (folder layout, config files listed, minimal mcp.json snippet).
- `cursor-example/README.md`: same shape.
- `opencode-example/README.md`: same shape.

Each example README shows the directory structure + entry-point snippet (≤ 30 lines each) without committing real implementation code. The intent is a reference layout; separate repos contain actual code.

### 10. Tests (1 new file, ≥ 4 cases)

`src/tests/sdk-vega-client.test.ts`:
- Stub `globalThis.fetch`: happy ingest / happy retrieve / happy ack.
- Retry: simulate 503 twice then 200 → assert 3 attempts, returns result.
- Retry exhaustion: simulate 503 × 4 → throws after 3 attempts.
- 4xx: simulate 400 → throws immediately (no retry on client errors).

## Out of scope — do NOT touch

- `src/reconciliation/**`, `src/monitoring/vega-metrics.ts`, `metrics-fingerprint.ts`, `metrics.ts`, `dashboards/**`
- `src/scheduler/**`, `src/notify/**`, `src/sunset/**`, `src/alert/**`, `src/backup/**`, `src/timeout/**`, `src/checkpoint/**`, `src/feature-flags/**`
- `src/retrieval/**`, `src/api/server.ts`, `src/mcp/server.ts`, `src/api/mcp.ts`, `src/index.ts`
- `.eslintrc.cjs`, `src/db/migrations/**`, `src/core/contracts/**`
- All existing tests except adding 1 new `sdk-vega-client.test.ts`

## Forbidden patterns

- Production code MUST NOT sniff test env
- Tests MUST NOT actually make HTTP requests (stub globalThis.fetch)
- NO amend of e2006be / e3a4470
- SDK error responses must be structured (status code + message), never raw
- Docs must NOT reference commit SHAs older than 93bdd09 as current state (only use latest framework SHAs for current references)

## Acceptance criteria

1. `src/sdk/vega-client.ts` + `src/sdk/index.ts` exist; SDK ≤ 150 lines
2. `rg -n "fetch" src/sdk/vega-client.ts` ≥ 1 (uses globalThis.fetch)
3. `docs/guides/host-integration/README.md` has 4 section headings
4. `docs/guides/host-integration/{claude-code,cursor,opencode}.md` each have 4 section headings
5. `docs/guides/host-integration/troubleshooting.md` has 5 section headings
6. `docs/guides/host-integration/migration.md` has 4 section headings
7. `docs/examples/{README.md,claude-code-example/README.md,cursor-example/README.md,opencode-example/README.md}` exist
8. `src/tests/sdk-vega-client.test.ts` exists; `rg -c "^test\(" src/tests/sdk-vega-client.test.ts` ≥ 4
9. `git diff HEAD -- src/reconciliation/ src/monitoring/vega-metrics.ts src/monitoring/metrics-fingerprint.ts src/monitoring/metrics.ts dashboards/ src/scheduler/ src/notify/ src/sunset/ src/alert/ src/backup/ src/timeout/ src/checkpoint/ src/feature-flags/ src/retrieval/ src/api/server.ts src/mcp/server.ts src/api/mcp.ts src/index.ts .eslintrc.cjs src/db/migrations/ src/core/contracts/` outputs empty
10. `git diff HEAD -- src/tests/` shows only new `sdk-vega-client.test.ts`
11. `set -o pipefail; npm run build` exits 0; `set -o pipefail; npm test` ≥ 1188 pass / 0 fail
12. Not-amend; new commit
13. Commit title prefix `feat(sdk):` OR `docs(guides):` (codex chooses based on whether SDK changes dominate)
14. Commit body:
    ```
    Ships the host-integration SDK + documentation suite P8-041.1-.6:
    - src/sdk/{vega-client,index}.ts: thin TypeScript SDK wrapping ingest
      / retrieve / ack via globalThis.fetch. 3x retry on 5xx/network,
      no retry on 4xx; structured errors; ≤ 150 LoC.
    - docs/guides/host-integration/README.md: quick start / surface
      registration / example integrations / API reference.
    - Three integration guides (claude-code.md / cursor.md / opencode.md)
      each covering architecture / installation / event mapping / host
      tier.
    - docs/guides/host-integration/troubleshooting.md: common errors /
      observability / retrieval debug / ingest debug / escalation.
    - docs/guides/host-integration/migration.md: deprecated APIs / 5-step
      runbook / compatibility window (links P8-033 sunset) / validation.
    - docs/examples/{claude-code,cursor,opencode}-example/README.md:
      reference layouts for actual integration repos.
    - 1 new sdk-vega-client.test.ts (≥ 4 cases): happy paths, retry
      success, retry exhaustion, 4xx immediate throw. Tests stub
      globalThis.fetch — no real HTTP.

    Scope: pure documentation + thin SDK skeleton. Zero touches to
    reconciliation / monitoring / scheduler / notify / sunset / alert /
    backup / timeout / checkpoint / feature-flags / retrieval / api /
    mcp / migrations / contracts.

    Scope-risk: minimal
    Reversibility: clean
    ```

## Review checklist

- Does SDK stay ≤ 150 LoC?
- Does SDK error path use structured error shape?
- Do tests stub `globalThis.fetch` (no real HTTP)?
- Do all 5 guides contain their required heading counts?
- Does migration.md cross-link P8-033 sunset?
- New commit stacks on `e3a4470` (not amend)?

## Commit discipline

- Single atomic commit, new stack on HEAD
- Title prefix `feat(sdk):` if SDK is majority; else `docs(guides):`
- Body per Acceptance #14
- New docs all under `docs/guides/host-integration/` or `docs/examples/`
