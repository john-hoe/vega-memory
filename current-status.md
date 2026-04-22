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
