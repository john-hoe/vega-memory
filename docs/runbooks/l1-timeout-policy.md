# L1 Timeout Policy

## Policy summary

L1 checkpoint timeout sweeps classify expired checkpoints by `host_tier`.

- `T1` and `T2` become `presumed_sufficient` events and do not produce a hard failure row.
- `T3` and `unknown` become `hard_failure` outcomes.
- Hard failures use reason codes in the `l1_ttl_expired_tier_*` family and recorder category `l1_ttl_expired`.
- If the Wave 3 checkpoint schema does not expose the timeout fields required by the detector, the sweep returns `degraded: "schema_incompatible"` instead of modifying schema or throwing.

## Sweep triggers

The timeout policy can run from two entrypoints.

- Background scheduler: `src/timeout/scheduler.ts` uses `setInterval` with a default 60 second cadence.
- Manual MCP trigger: call `checkpoint.timeout_sweep` with an optional `max_per_run` override.

Both paths are non-throwing and return partial/degraded responses when the backend cannot safely execute the sweep.

## Tuning

Use these environment variables to control behavior:

- `VEGA_TIMEOUT_SWEEP_INTERVAL_MS`
  Positive integer override for the scheduler interval. Invalid or non-positive values fall back to `60000`.
- `VEGA_TIMEOUT_SWEEP_MAX_PER_RUN`
  Positive integer cap for how many expired checkpoints a single sweep will inspect. Invalid or non-positive values fall back to `100`.
- `VEGA_TIMEOUT_SWEEP_ENABLED`
  Set to `false` to disable the background scheduler. The manual MCP tool remains available.

## Inspecting outcomes

Check the timeout failure sink for rows in the `l1_ttl_expired` family:

```sql
SELECT checkpoint_id, reason, category, created_at
FROM checkpoint_failures
WHERE category = 'l1_ttl_expired'
ORDER BY created_at DESC;
```

Correlate the affected checkpoint IDs with the source timeout records and host-tier metadata exposed by the active checkpoint schema. When the detector is running against a schema that carries `host_tier`, the returned MCP `records` array already includes the per-checkpoint decision and reason code.

## When this fires unexpectedly

Common causes:

- Clock skew between the producer and the Vega process causes checkpoints to look expired too early.
- High-latency downstream resolution stretches the turn past the configured L1 TTL window.
- Host-tier misclassification upgrades a soft path into a `T3` or `unknown` timeout.

Recommended remediation:

1. Compare the sweep timestamp with the checkpoint `created_at` and TTL window to confirm whether expiry is real or a clock issue.
2. Inspect downstream latency around the same window to see whether resolution work exceeded the expected L1 turnaround.
3. Verify host-tier assignment logic for the affected requests and correct misclassified callers before widening TTLs.
4. If the MCP result shows `degraded: "schema_incompatible"`, treat it as a schema follow-up for a later wave rather than patching Wave 3 tables in place.
