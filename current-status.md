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
- Independent verification after the fix:
  - `npm run build` → pass
  - `node --test dist/tests/ingestion-pipeline.test.js dist/tests/ingestion-ingest-event-handler.test.js dist/tests/mcp-candidate-tools.test.js dist/tests/wiring-integration.test.js dist/tests/judgment-rules.test.js` → `47 passed / 0 failed`
  - `npm test` → `1350 passed / 0 failed`

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
