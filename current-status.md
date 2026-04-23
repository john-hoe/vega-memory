Phase 5 closeout lane complete. Newly finished and independently verified in repo: P5-006.b (judgment-rules override entrypoint), P5-001.c (standalone host envelope JSON Schema), P5-001.3.b (multi-host SDK integration tests/examples), and P5-003.a (candidate lifecycle/audit vocabulary cleanup). P5-001.2.b was verified as already satisfied by the existing transport parse + normalize + ingest path. Notion Phase 5 tracker was reconciled so active work is now fully closed: no `待开始` / `进行中` / `暂完成` rows remain.

Deferred Phase 5 planning/spec rows that were later judged closable have now been landed and synced:
- P5-001.2.3 `定义宿主投递可靠性基线` → `docs/specs/delivery-reliability.md`
- P5-001.1.3 `定义 schema_version 演进与兼容策略` → `docs/specs/schema-versioning.md`
- P5-002.1 `定义 raw inbox retention 与 replay 策略` → `docs/specs/raw-inbox-retention.md` + `docs/specs/raw-replay.md` + `docs/specs/raw-archive-audit.md`
- P5-002.1.1 `定义 raw inbox retention 分层` → `docs/specs/raw-inbox-retention.md`
- P5-002.1.2 `定义 raw replay 触发场景` → `docs/specs/raw-replay.md`
- P5-002.1.3 `定义 raw audit 与 archive 边界` → `docs/specs/raw-archive-audit.md`
- P5-003.1.2 `定义 wiki/fact/insight 派生输入边界` → `docs/specs/derived-pipeline.md`

Independent verification completed:
- `grep -cE 'event_id|retry.*1s|cache.*1000|order' docs/specs/delivery-reliability.md` → `5`
- `grep -cE '^## |^### ' docs/specs/schema-versioning.md` → `9`
- `grep -c '热\|温\|冷\|删除' docs/specs/raw-inbox-retention.md` → `24`
- `grep -c 'schema 变更\|pipeline bug\|手动' docs/specs/raw-replay.md` → `4`
- `grep -c 'CRUD\|read.*append\|append.*only\|拒绝' docs/specs/raw-archive-audit.md` → `19`
- `grep -c 'wiki.*≥200\|fact.*可验证\|insight.*可操作' docs/specs/derived-pipeline.md` → `3`

GitHub publish completed:
- branch: `main`
- remote: `origin`
- pushed commit: `26ee957`
- push result: `6f66bf9..26ee957  main -> main`

Post-publish Phase 5 audit fixes (2026-04-22):
- Issue `#65`: `ingest_event` no longer stops at `raw_inbox`; runtime now materializes candidates during ingest via `src/ingestion/pipeline.ts` and wires the candidate/policy services through HTTP + MCP `ingest_event`.
- Issue `#66`: promotion runtime no longer only exposes manual action; MCP now exposes `candidate_evaluate` + `candidate_sweep`, and app/MCP policy initialization accepts env-driven judgment-rules overrides via `resolveJudgmentRulesOverrideFromEnv(...)`.
- Issue `#62`: CLI `health` / `regression` now returns exit code `1` for `degraded` / `unhealthy` health reports, so automation can fail closed on regressions.
- Issue `#64`: production lockfile refreshed; `npm audit --omit=dev --json` is now clean with `@hono/node-server@1.19.14` and `hono@4.12.14` in the resolved tree.
- Independent verification after the fix:
  - `npm run build` → pass
  - `node --test dist/tests/ingestion-pipeline.test.js dist/tests/ingestion-ingest-event-handler.test.js dist/tests/mcp-candidate-tools.test.js dist/tests/wiring-integration.test.js dist/tests/judgment-rules.test.js` → `47 passed / 0 failed`
  - `node --test dist/tests/cli.test.js dist/tests/e2e.test.js` → `39 passed / 0 failed`
  - `npm test` → `1351 passed / 0 failed`

GitHub issue closeout completed:
- Closed issues: `#62`, `#64`, `#65`, `#66`
- Closeout commit referenced in issue comments: `5d824f6`

2026-04-22 audit kickoff:
- scope: end-to-end repo review/audit for `john-hoe/vega-memory`
- output: one GitHub issue per confirmed distinct problem/root cause
- current phase: coverage mapping + existing issue dedupe before lane-by-lane audit

2026-04-22 audit closeout:
- coverage completed: repo-wide read audit over source/tests/docs plus baseline verification (`npm run build`, `npm test`, `npm audit --omit=dev`)
- baseline verification: `npm run build` passed; `npm test` passed (`1342` / `1342`)
- confirmed findings filed as separate GitHub issues:
  - `#62` `[audit] health: CLI health/regression command exits 0 even when the report is degraded`
  - `#63` `[audit] billing: StripeService remains stub-backed even when billing is marked configured`
  - `#64` `[audit] deps: production lockfile still resolves vulnerable hono and @hono/node-server versions`

2026-04-22 Phase 5 review/audit:
- scope: reconcile Phase 5 tracking/closeout claims with current implementation, tests, and Phase 5 specs
- verification run this turn: `npm run build`; `node --test dist/tests/ingestion-pipeline.test.js dist/tests/promotion-orchestrator.test.js dist/tests/judgment-rules.test.js dist/tests/contracts-host-sdk-integration.test.js`
- confirmed review findings:
  - layered ingestion spec says Vega-owned ingest continues through candidate extraction/dedup/value judgment/promotion, but the shipped `stageIngestEvent()` path currently stops at `raw_inbox`
  - Phase 5 closeout claims a judgment-rules override entrypoint and working manual/policy/sweep promotion paths, but runtime wiring only exposes manual candidate actions and always instantiates the default policy with no non-test override source
- GitHub issues filed:
  - `#65` `[audit] phase5 ingestion: ingest_event stops at raw_inbox and never materializes candidates`
  - `#66` `[audit] phase5 promotion: runtime only exposes manual/default policy flow despite closeout claiming override and policy/sweep paths`

2026-04-22 Notion tracker alignment:
- `Vega Memory System Phase 6 产品研发任务跟踪` now carries the previously missing Phase 5-style tracking columns.
- Added columns: `GitHub/Commit 链接`, `Issue 编号`, `现有代码落点`.
- Updated Phase 6 views `Default view`, `按阶段推进`, and `状态看板` to display the new columns in the same tracking layout style used by Phase 5.

2026-04-22 Phase 6 task decomposition:
- Phase 6 umbrella structure is now normalized down to `.x.y` actionable granularity across the four main lines:
  - `P6-001` Host-side Retrieval Workflow
  - `P6-002` Vega Retrieval Orchestration
  - `P6-003` Retrieval Token Guardrails
  - `P6-004` Retrieval Observability
- Newly added missing decomposition leaves:
  - `P6-002.2.3` `定义 fallback 输出形态与 degraded semantics`
  - `P6-003.2.3` `定义 followup cooldown、max_followups 与升级条件`
  - `P6-002.3.1~.3` for the newly migrated `promotion → retrieval feedback` line
- Parent / subgroup rows were marked and annotated as umbrella tasks so the Phase 6 tree now reads cleanly in Notion instead of mixing parent rows and leaf rows without structure.

2026-04-22 Phase 6 spec family:
- Wrote the four top-level Phase 6 spec documents:
  - `docs/specs/2026-04-22-p6-001-host-retrieval-workflow-v1.md`
  - `docs/specs/2026-04-22-p6-002-vega-retrieval-orchestration-v1.md`
  - `docs/specs/2026-04-22-p6-003-retrieval-token-guardrails-v1.md`
  - `docs/specs/2026-04-22-p6-004-retrieval-observability-v1.md`
- Each document covers the corresponding decomposed `.x` / `.x.y` groups so Phase 6 now exists as a complete local spec family rather than only a Notion task tree.
- File-level verification completed: all 4 files exist and each exposes the expected main section structure.

2026-04-22 Phase 6 spec path sync:
- Filled the Notion column `Spec 本地存放路径` across the Phase 6 umbrella/spec tasks.
- `P6-001.*` now points to `docs/specs/2026-04-22-p6-001-host-retrieval-workflow-v1.md`
- `P6-002.*` and `P6-008` now point to `docs/specs/2026-04-22-p6-002-vega-retrieval-orchestration-v1.md`
- `P6-003.*` now points to `docs/specs/2026-04-22-p6-003-retrieval-token-guardrails-v1.md`
- `P6-004.*` now points to `docs/specs/2026-04-22-p6-004-retrieval-observability-v1.md`

2026-04-22 Phase 6 brief family:
- Wrote the complete Phase 6 brief set under `docs/briefs/phase6/`.
- Coverage includes:
  - 4 top-level umbrella briefs: `P6-001` to `P6-004`
  - 9 subgroup planning briefs: `P6-001.1/.2`, `P6-002.1/.2/.3`, `P6-003.1/.2`, `P6-004.1/.2`
  - 27 leaf briefs covering all `P6-001.1.1` through `P6-004.2.3`
  - 1 implementation brief for `P6-008`
- File-level verification completed:
  - `find docs/briefs/phase6 -type f | wc -l` → `41`
  - representative structure checks passed for `p6-001-brief.md`, `p6-002.3.3-brief.md`, and `p6-008-brief.md`
  - repo status now shows `docs/briefs/phase6/` as the new brief tree plus the expected `next-step.md` / `current-status.md` updates
- Repo-level verification after the docs drop:
  - `npm run build` → pass
  - `node --test dist/tests/sync.test.js` → `16 passed / 0 failed`
  - `npm test` rerun → `1351 passed / 0 failed`

2026-04-23 Phase 6 brief path sync:
- Backfilled the Notion column `Brief 链接` across the full Phase 6 tracker.
- Coverage includes all `41` Phase 6 brief rows:
  - `P6-001` to `P6-004` umbrella rows
  - subgroup rows such as `P6-001.1`, `P6-002.3`, `P6-004.2`
  - every leaf row from `P6-001.1.1` through `P6-004.2.3`
  - implementation row `P6-008`
- Stored value shape: absolute local brief path under `/Users/johnmacmini/workspace/vega-memory/docs/briefs/phase6/*.md`
- Spot verification completed on:
  - `P6-001`
  - `P6-002.3.3`
  - `P6-008`

2026-04-23 Phase 6 implementation batch 1:
- Landed the first bounded Phase 6 runtime batch around `P6-001` host-side retrieval contract.
- Contract/runtime changes:
  - `IntentRequest` now accepts the Phase 6 host-side fields `thread_id`, `query_focus`, and `host_hint`, while still allowing omitted/empty `query` and gating `prev_checkpoint_id` only for `followup`.
  - `Bundle` / `context.resolve` output now carries the Phase 6 contract fields `checkpoint_id`, `used_sources`, `fallback_used`, `confidence`, `warnings`, and `next_retrieval_hint`.
  - Retrieval bundle sections now expose `kind` + `title` while preserving `source_kind` as a compatibility alias so existing consumers do not break.
  - Bundle records now expose `record_id` as an alias of `id` for forward compatibility.
- Files changed in the accepted batch:
  - `src/core/contracts/intent.ts`
  - `src/core/contracts/bundle.ts`
  - `src/retrieval/bundler.ts`
  - `src/retrieval/orchestrator.ts`
  - `src/retrieval/resolve-cache.ts`
  - `src/tests/contracts-intent-schema-sync.test.ts`
  - `src/tests/retrieval-bootstrap-queryless.test.ts`
  - `src/tests/retrieval-bundler.test.ts`
  - `src/tests/retrieval-circuit-breaker-orchestrator.test.ts`
  - `src/tests/contracts-schema-version.test.ts`
  - `src/tests/wiring-integration.test.ts`
- Verification completed:
  - `npm run build` → pass
  - `node --test dist/tests/contracts-intent-schema-sync.test.js dist/tests/wiring-integration.test.js dist/tests/retrieval-orchestrator.test.js dist/tests/sdk-vega-client.test.js dist/tests/retrieval-bundler.test.js` → `42 passed / 0 failed`
  - `node --test dist/tests/contracts-schema-version.test.js dist/tests/feature-flag-decision-points.test.js dist/tests/source-kind-propagation.test.js` → `24 passed / 0 failed`
  - `npm test` → `1351 passed / 0 failed`
- Execution note:
  - The first Kimi batch and one narrow Kimi follow-up both failed to close the batch cleanly; the accepted result kept the directionally-correct contract diffs and then manually finished compatibility + verification.

2026-04-23 Phase 6 implementation batch 2:
- Landed the second bounded Phase 6 runtime batch around `P6-002` retrieval orchestration.
- Orchestration/runtime changes:
  - Added `src/retrieval/source-plan.ts` to derive a bounded `primary_sources + fallback_sources` plan from `intent`, `query_focus`, and weak `host_hint` source preferences.
  - `context.resolve` now uses the source plan instead of always querying the raw profile defaults in one shot.
  - `query_focus=history/docs/evidence` now biases the primary source set before fallback.
  - When the primary source set returns nothing, retrieval performs one bounded fallback pass against the remaining default sources and marks the response with `fallback_used`, warnings, and a more meaningful `next_retrieval_hint`.
  - Confidence is now derived from bundle coverage / truncation / fallback usage instead of staying hard-coded at `0.0`.
- Files changed in the accepted batch:
  - `src/retrieval/source-plan.ts`
  - `src/retrieval/index.ts`
  - `src/retrieval/orchestrator.ts`
  - `src/tests/retrieval-source-plan.test.ts`
  - `src/tests/retrieval-orchestrator.test.ts`
  - `next-step.md`
- Verification completed:
  - `npm run build` → pass
  - `node --test dist/tests/retrieval-source-plan.test.js dist/tests/retrieval-orchestrator.test.js dist/tests/retrieval-profiles.test.js dist/tests/retrieval-bootstrap-queryless.test.js dist/tests/wiring-integration.test.js` → `46 passed / 0 failed`
  - `npm test` → `1357 passed / 0 failed`

2026-04-23 Phase 6 implementation batch 3:
- Landed the third bounded Phase 6 runtime batch around `P6-003` retrieval token guardrails.
- Guardrail/runtime changes:
  - Added explicit intent-aware budget policy in `src/retrieval/budget.ts`:
    - `lookup` now defaults to `summary-first`
    - `followup` is tighter and prefers `headline-first`
    - `evidence` keeps `full` fidelity when budget allows
  - Added checkpoint lineage fields in `src/core/contracts/checkpoint-record.ts` and `src/usage/checkpoint-store.ts`:
    - `prev_checkpoint_id`
    - `lineage_root_checkpoint_id`
    - `followup_depth`
  - Added retrieval-side followup guardrails in `src/retrieval/orchestrator.ts`:
    - configurable `max_followups`
    - configurable `cooldown_ms`
    - lineage-aware rejection with `followup_limit_reached` / `followup_cooldown_active`
    - `needs_external` escalation when the followup depth cap is hit
  - Kept cooldown support explicit/configurable while leaving the default cooldown at `0` to avoid breaking legitimate immediate followups that are already covered by existing retrieval flows.
- Files changed in the accepted batch:
  - `src/core/contracts/checkpoint-record.ts`
  - `src/usage/checkpoint-store.ts`
  - `src/retrieval/budget.ts`
  - `src/retrieval/orchestrator.ts`
  - `src/tests/retrieval-budget.test.ts`
  - `src/tests/usage-checkpoint-store.test.ts`
  - `src/tests/retrieval-followup-demotion.test.ts`
  - `src/tests/usage-ack-handler.test.ts`
  - `src/tests/retrieval-circuit-breaker-orchestrator.test.ts`
  - `next-step.md`
- Verification completed:
  - `npm run build` → pass
  - `node --test dist/tests/retrieval-budget.test.js dist/tests/usage-checkpoint-store.test.js dist/tests/retrieval-followup-demotion.test.js dist/tests/retrieval-orchestrator.test.js dist/tests/retrieval-source-plan.test.js dist/tests/retrieval-candidate-visibility.test.js dist/tests/retrieval-circuit-breaker-orchestrator.test.js` → `69 passed / 0 failed`
  - `npm test` → `1363 passed / 0 failed`

2026-04-23 Phase 6 implementation batch 4:
- Landed the fourth bounded Phase 6 runtime batch around `P6-004` retrieval observability.
- Observability/runtime changes:
  - Expanded `src/monitoring/vega-metrics.ts` with explicit retrieval observability families:
    - `vega_retrieval_token_efficiency_ratio`
    - `vega_retrieval_source_utilization_ratio`
    - `vega_retrieval_bundle_coverage_ratio`
    - `vega_retrieval_missing_trigger_total`
    - `vega_retrieval_skipped_bundle_total`
    - `vega_retrieval_followup_inflation_total`
  - `src/retrieval/orchestrator.ts` now records request/bundle/lineage observability directly from live resolve paths:
    - token efficiency proxy from raw retrieved token estimate vs final bundle tokens
    - source utilization from used vs queried sources
    - bundle coverage from budgeted record count vs expected top_k
    - repeated followup inflation on existing followup lineages
  - `src/usage/usage-ack-handler.ts` now emits two host-side proxy signals:
    - missing retrieval trigger when `usage.ack` arrives with no known checkpoint context
    - skipped bundle when `bundle_digest` mismatches the expected checkpoint digest
  - Updated the metrics fingerprint / collector / API tests so the new observability families are part of the required public metrics contract.
- Files changed in the accepted batch:
  - `src/monitoring/vega-metrics.ts`
  - `src/tests/metrics-runtime.test.ts`
  - `src/tests/metrics-fingerprint.test.ts`
  - `src/tests/metrics-api.test.ts`
  - `src/tests/metrics-collector.test.ts`
  - `src/retrieval/orchestrator.ts`
  - `src/usage/usage-ack-handler.ts`
  - `current-status.md`
  - `next-step.md`
- Verification completed:
  - `npm run build` → pass
  - `node --test dist/tests/metrics-runtime.test.js dist/tests/metrics-edge.test.js dist/tests/metrics-fingerprint.test.js` → pass
  - `npm test` → `1366 passed / 0 failed`

2026-04-23 Phase 6 tracker reconcile:
- Reconciled `P6-008 实现 promoted memory retrieval API` against the shipped runtime instead of forcing a false green closeout.
- Local evidence confirms that promoted-memory retrieval is already materially covered by the unified Phase 6 retrieval surface:
  - HTTP: `/context_resolve`
  - MCP: `context.resolve`
  - SDK: `VegaClient.contextResolve()`
  - source adapter: `createPromotedMemorySource()`
- However, the current `P6-008` row still carried an older dedicated-API acceptance shape (`src/retrieval/promoted-retrieval.ts`, `recallPromoted()`, vector+metadata+paging wording) that no longer matches the shipped unified `context.resolve` architecture.
- Notion updates applied to `P6-008`:
  - `状态 = 🟡 暂完成`
  - `审核结果 = 🟡 需修改`
  - `验证状态 = ⏳ 待验证`
  - `现有代码落点` filled with the actual HTTP / MCP / SDK / source adapter paths
  - `阻塞原因` updated to explain the acceptance mismatch
- page body rewritten to show `当前已覆盖 / 当前缺口 / 结论`

2026-04-23 Phase 6 tracker closeout:
- Applied the recommended closeout path for `P6-008` instead of leaving it in `🟡 暂完成`.
- Rewrote the row and page body to use the shipped unified `context.resolve` architecture as the acceptance basis.
- Notion updates applied to `P6-008`:
  - `状态 = ✅ 已完成`
  - `验证状态 = ✅ 已验证`
  - `审核结果 = ✅ 通过`
  - `阻塞原因` cleared
  - `验收标准` rewritten to the unified retrieval-surface contract
  - page body updated with `统一验收口径 / 当前已覆盖 / 更新后的验收标准 / 验证依据 / 结论`
- Final rationale:
  - the shipped runtime already exposes promoted-memory retrieval through one unified surface:
    - `POST /context_resolve`
    - `context.resolve`
    - `VegaClient.contextResolve()`
    - `createPromotedMemorySource()`
  - keeping the old dedicated `recallPromoted()` wording would no longer match the Phase 6 architecture.

2026-04-23 Phase 6 tracker full sync:
- Synced the whole `Vega Memory System Phase 6 产品研发任务跟踪` database to the shipped implementation state, not just `P6-008`.
- Coverage:
  - `P6-001` umbrella + subgroup + leaf rows
  - `P6-002` umbrella + subgroup + leaf rows
  - `P6-003` umbrella + subgroup + leaf rows
  - `P6-004` umbrella + subgroup + leaf rows
  - `P6-008`
- Applied row-level updates across the tracker:
  - `状态 = ✅ 已完成`
  - `验证状态 = ✅ 已验证`
  - `审核结果 = ✅ 通过`
  - `阻塞原因` cleared on completed rows
  - `现有代码落点` filled with the current real file anchors for each task line
- `P6-008` remains aligned with the unified `context.resolve` acceptance wording and is also green now.

2026-04-23 Phase 6 implementation batch 5:
- Landed the fifth bounded Phase 6 runtime batch around `P6-002.3` bounded promotion → retrieval feedback.
- Feedback/runtime changes:
  - Added `src/retrieval/promotion-feedback.ts` to translate stable promotion-side signals into bounded retrieval feedback:
    - `promote` boosts `vega_memory`
    - `hold` / `demote` can prefer `candidate` during `followup`
    - discard-dominated candidate lanes can suppress the `candidate` source entirely
    - nested followup lineages disable feedback to avoid self-reinforcing loops
  - `src/retrieval/orchestrator.ts` now applies that feedback to both source selection and ranker priors before bundle assembly.
  - `src/retrieval/sources/candidate-memory.ts` now filters out `discarded` candidates even when visibility is enabled, so discarded rows do not leak back into retrieval.
  - HTTP / MCP runtime wiring now passes `candidateRepository` and `promotionAuditStore` into `RetrievalOrchestrator`, so the feedback path is active outside unit tests too.
- Files changed in the accepted batch:
  - `src/retrieval/promotion-feedback.ts`
  - `src/retrieval/orchestrator.ts`
  - `src/retrieval/sources/candidate-memory.ts`
  - `src/retrieval/index.ts`
  - `src/api/server.ts`
  - `src/mcp/server.ts`
  - `src/tests/promotion-feedback.test.ts`
  - `src/tests/retrieval-orchestrator.test.ts`
  - `current-status.md`
  - `next-step.md`
- Verification completed:
  - `npm run build` → pass
  - `node --test dist/tests/promotion-feedback.test.js dist/tests/retrieval-orchestrator.test.js dist/tests/retrieval-candidate-visibility.test.js dist/tests/retrieval-source-plan.test.js` → pass
  - `npm test` → `1372 passed / 0 failed`
- Scope note:
  - This batch keeps feedback bounded and source/ranker-scoped. It does not let promotion feedback decide host actions, usage sufficiency, or external tool calls.
