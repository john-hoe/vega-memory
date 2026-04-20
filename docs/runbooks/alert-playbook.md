# Alert Playbook

## Alert triage

Treat `critical` alerts as immediate response items: confirm the signal, inspect the affected metric, and start remediation before the next cooldown window. Treat `warn` alerts as same-shift investigations: verify whether the threshold breach is sustained, then either resolve the underlying cause or adjust the rule only after confirming the metric semantics. For `info` alerts, record the event and watch for escalation.

If `alert.check` returns `rules_missing`, restore `docs/alerts/alert-rules.yaml`. If it returns `channels_missing`, restore or repopulate `docs/alerts/channels.yaml`. If it returns `parse_error`, fix the checked-in YAML before assuming the alert engine is healthy.

## Per-rule playbooks

### `retrieval_coverage_low`

Diagnosis: run `alert.check` and confirm `vega_retrieval_nonempty_ratio` is below the configured threshold across the rule window. Cross-check retrieval logs and recent recall-path changes.

Remediation: inspect retrieval adapters, recent source-registry changes, and checkpoint/circuit-breaker behavior. If the ratio is low because sources are intentionally disabled, update the rule threshold only after documenting the new expected baseline.

### `usage_ack_sufficiency_low`

Diagnosis: confirm `vega_usage_ack_sufficiency_insufficient_ratio` is elevated for the last ten minutes. Review recent `usage.ack` traffic and checkpoint-failure patterns.

Remediation: inspect the usage ack classifier, checkpoint store, and any recent prompt-surface changes that may have reduced acknowledgment quality. Resolve persistent insufficient responses before lowering the threshold.

### `circuit_breaker_open`

Diagnosis: confirm `vega_circuit_breaker_state` remains above `0` for the full rule window. Review MCP/API degradation logs and the affected retrieval surface.

Remediation: identify the failing dependency or repeated checkpoint failure that opened the breaker, repair the dependency, then verify the breaker returns to `closed` before considering the incident resolved.

### `raw_inbox_backlog_high`

Diagnosis: confirm `vega_raw_inbox_rows` exceeds the threshold for five minutes and inspect ingestion throughput. Check whether reconciliation or downstream consumers are stalled.

Remediation: restore ingestion consumers, clear blocked processing, and verify the backlog drains below threshold. If load legitimately increased, update the rule only after measuring the new steady-state queue size.

### `raw_inbox_oldest_age_high`

Diagnosis: confirm `vega_raw_inbox_oldest_age_seconds` exceeds one hour. This usually indicates a stuck ingestion or reconciliation lane rather than a transient burst.

Remediation: inspect the oldest raw inbox items, restart or repair the stalled consumer, and verify both backlog age and row count recover. If items are permanently malformed, triage and remove or reprocess them intentionally.

## Cooldown and dedupe

`src/alert/history.ts` records each firing in the SQLite `alert_history` table and uses the most recent unresolved row to suppress duplicate notifications during the cooldown window. The scheduler only re-fires after `VEGA_ALERT_COOLDOWN_MS` has elapsed or after the rule resolves and the unresolved history row is marked with `resolved_at`.

To inspect dedupe state, query `alert_history` for the target `rule_id` and compare `fired_at` and `resolved_at`. Manual resolution means updating the underlying condition so the evaluator emits `resolved`; the scheduler then marks the latest unresolved record as resolved on the next tick.

## Channel debugging

Use the `alert.fire` MCP tool to test delivery without waiting for a threshold breach:

```json
{
  "rule_id": "circuit_breaker_open",
  "reason": "channel smoke test"
}
```

If delivery fails, inspect `dispatch_status` first. `error:channel_not_found` means the rule references a channel id not present in `docs/alerts/channels.yaml`. HTTP errors indicate webhook, Slack, or Telegram endpoint problems. Because Slack and Telegram are thin wrappers around the webhook transport, verify their URL or token configuration the same way: correct secret expansion, reachable endpoint, and non-4xx response.
