# Batch 28a.1 — Close B7 review: MCP usage.ack flag regression + runbook correction

## Context

B7 review of `5c3a92f` returned PASS (not SEAL PASS) with 1 MEDIUM + 1 LOW:

- **MEDIUM**: `usage-ack-echo-source-kind` flag is wired at both HTTP `/usage_ack` and MCP `usage.ack`, but only HTTP is covered by on/off regression. If MCP surface drifts, tests don't catch it.
- **LOW**: `docs/adapters/canary-rollout.md:70` says `ranker-recency-halflife-14d` decision point is `orchestrator.ts`. Actual location is `src/retrieval/ranker.ts:67` + `src/retrieval/ranker-score.ts`. Operators following runbook would look in wrong file.

No amend — new commit on HEAD (parent = `5c3a92f`).

## Scope

### 1. `src/tests/feature-flag-decision-points.test.ts` — add 2 MCP usage.ack cases

Append 2 test cases paralleling the existing HTTP pair:

1. **MCP usage.ack on → echoed_source_kinds present**: call the MCP `usage_ack` handler (via registered tool factory or direct `usageAckHandler` if exposed) with a bundle carrying `source_kind`s; flag tmp registry sets `usage-ack-echo-source-kind` default `on`; assert response (or tool result) carries `echoed_source_kinds: [...]`.

2. **MCP usage.ack off → echoed_source_kinds omitted**: same as above but flag registry sets `default: off, traffic_percent: 0`; assert response omits `echoed_source_kinds` (or `[]` / `undefined` depending on impl).

Look at existing HTTP test pair for the pattern; mirror it using MCP surface. Use tmp registry via `mkdtempSync` + override env / path (same pattern as HTTP cases). Don't touch live `docs/feature-flags/flags.yaml`.

If MCP is hard to invoke hermetically (e.g. requires full MCP server startup), at minimum call the underlying handler function directly with a fabricated flag-resolution context.

### 2. `docs/adapters/canary-rollout.md:70` — correct decision-point path

The "Live decision points" section currently says (illustrative):
```
- `ranker-recency-halflife-14d` → decision at `src/retrieval/orchestrator.ts`
```

Update to:
```
- `ranker-recency-halflife-14d` → decision at `src/retrieval/ranker.ts:67` (flag evaluation) + `src/retrieval/ranker-score.ts` (halfLifeDays parameter)
```

## Out of scope — do NOT touch

- Everything outside: `src/tests/feature-flag-decision-points.test.ts` + `docs/adapters/canary-rollout.md` + this brief file
- No other files — tight corrective

## Forbidden patterns

- NO amend of prior commits — new commit on HEAD (parent = `5c3a92f`)
- Tests MUST use tmp registry (no live flags.yaml modification)
- Tests MUST NOT spin up a real MCP server if avoidable — direct handler invocation preferred
- NO structural changes to existing 6 tests — only append

## Acceptance criteria

1. `rg -c "^test\\(" src/tests/feature-flag-decision-points.test.ts` ≥ 8 (was 6; +2 MCP cases)
2. `rg -n "usage.ack.*MCP|MCP.*usage.ack|mcp.*usage_ack" src/tests/feature-flag-decision-points.test.ts` ≥ 2 (both new cases reference MCP)
3. `docs/adapters/canary-rollout.md` references `src/retrieval/ranker.ts` for the half-life flag (grep `ranker\\.ts` in the decision-point section ≥ 1)
4. `docs/adapters/canary-rollout.md` does NOT say decision point for recency half-life is in `orchestrator.ts` — grep `orchestrator\\.ts` within decision-point section for `ranker-recency-halflife-14d` context = 0
5. `git diff HEAD --name-only` ⊆ `{src/tests/feature-flag-decision-points.test.ts, docs/adapters/canary-rollout.md, docs/briefs/2026-04-21-batch28a1-mcp-usage-ack-flag-regression.md}` (brief is allowed)
6. `set -o pipefail; npm run build` exits 0; `set -o pipefail; npm test` ≥ 1241 pass / 0 fail (1239 + 2 new)
7. `npm run lint:readonly-guard` exits 0
8. Not-amend; parent of new commit = `5c3a92f`
9. Commit title prefix `test(feature-flags):` OR `chore(feature-flags):` (codex picks)
10. Commit body:
    ```
    Close B7 review: MCP usage.ack flag regression + runbook path.

    - src/tests/feature-flag-decision-points.test.ts: added 2 MCP-surface
      cases for usage-ack-echo-source-kind (on + off). HTTP and MCP now
      symmetric — either surface drifting will fail regression.
    - docs/adapters/canary-rollout.md: corrected
      ranker-recency-halflife-14d decision-point path from orchestrator.ts
      to ranker.ts + ranker-score.ts (flag evaluation lives in ranker.ts
      call site; halfLifeDays parameter lives in ranker-score.ts).

    Scope: 2 files + 1 brief. No source/prod changes.

    Scope-risk: minimal
    Reversibility: clean
    ```

## Review checklist

- MCP on/off cases really invoke the MCP usage_ack handler (not just the HTTP one with a different name)?
- MCP tests use tmp registry (no pollution)?
- Runbook path correction accurate (ranker.ts, not orchestrator.ts)?
- New commit stacks on `5c3a92f` (not amend)?
- `npm test` still ≥ 1241?

## Commit discipline

- Single atomic commit
- Prefix `test(feature-flags):` OR `chore(feature-flags):`
- Body per Acceptance #10
