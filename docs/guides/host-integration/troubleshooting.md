# Host Integration Troubleshooting

## Common errors

| Error code | Typical cause | Fix |
| --- | --- | --- |
| `401 Unauthorized` | Missing or wrong `Authorization: Bearer ...` header | Set `VEGA_API_KEY` in the host process and confirm the SDK constructor receives it. |
| `400 ValidationError` | Envelope, intent, or ack payload shape does not match the contract | Compare the host payload against the SDK request types and the server contract before retrying. |
| `bundle_digest_mismatch` | `usage_ack` used a digest from a different retrieval result | Ack the exact `checkpoint_id` and `bundle_digest` pair returned by the preceding `context_resolve`. |
| `ack_already_recorded` | Host retried an ack with changed fields for the same checkpoint | Make `usage_ack` idempotent per checkpoint and do not mutate the ack payload after first send. |
| `persist_failed` | Vega accepted the ack request but could not write the SQLite-backed state | Check local storage health, logs, and whether the server is running in the expected SQLite mode. |
| `usage_ack_unavailable` | Ack persistence is not configured on the running server | Treat the ack as best-effort, then fix server startup or storage wiring before relying on ack analytics. |
| `5xx` or network failure | Vega process unavailable or transient server error | Let the SDK retry; if it still fails, inspect server logs and local reachability. |

## Observability

For live traffic, inspect the core Prometheus counters first:

- `vega_retrieval_calls_total`
- `vega_retrieval_nonempty_total`
- `vega_usage_ack_total`
- `vega_usage_followup_loop_override_total`

For data-quality drift, run the existing reconciliation surface and inspect the SQLite `reconciliation_findings` table or the `reconciliation.run` MCP tool output by `run_id`, `dimension`, and `severity`.

For alerting history, inspect SQLite `alert_history` by `rule_id`, `fired_at`, and `resolved_at`, then compare it with the active rules in [docs/alerts/alert-rules.yaml](../../alerts/alert-rules.yaml).

## Retrieval returns no records

1. Confirm `context_resolve` succeeded and did not return an error bundle (`bundle_digest !== "error"`).
2. Check `vega_retrieval_calls_total` versus `vega_retrieval_nonempty_total` for the same `surface` and intent.
3. Verify the host is sending the expected `query`, `surface`, `project`, and `cwd`.
4. Run reconciliation on the affected lane to see whether ingest happened but downstream bundles drifted.
5. If the retrieval bundle is consistently empty, inspect the upstream ingest flow before changing ranker or budget settings.

## Ingest rejects envelope

1. Inspect the `400 ValidationError` response body; Vega returns field-level `detail`.
2. Validate `schema_version`, `event_id`, canonical `surface`, and required envelope keys first.
3. Ensure `host_timestamp` is ISO-8601 and `payload` remains an object.
4. Re-run with the SDK request type rather than a hand-written JSON string when possible.
5. If the host emits attachments, verify every artifact has an `id` and `kind`.

## When to contact the Vega team

Escalate when all of the following are true:

- the SDK retries are exhausted or the server keeps returning structured 5xx errors,
- reconciliation shows drift you cannot localize to the host adapter,
- or alert history shows repeated unresolved failures after configuration has been corrected.

Include the failing endpoint, `surface`, `host_tier`, the exact structured error body, the relevant `checkpoint_id` or `event_id`, and the metric or reconciliation evidence you already gathered.
