# Legacy To New Host Integration Migration

## Deprecated APIs

| Deprecated client pattern | Deprecated since | Replacement |
| --- | --- | --- |
| Hand-written `fetch("/ingest_event")` wrapper without retry or structured errors | 2026-04-21 | `VegaClient.ingestEvent(...)` |
| Hand-written `fetch("/context_resolve")` wrapper with adapter-local response parsing | 2026-04-21 | `VegaClient.contextResolve(...)` |
| Hand-written `fetch("/usage_ack")` wrapper that retries every failure class | 2026-04-21 | `VegaClient.usageAck(...)` with built-in 5xx/network-only retry |
| Host-local ad hoc host-tier strings | 2026-04-21 | canonical `host_tier` values `T1`, `T2`, `T3` |

## Step-by-step migration

1. Install the SDK and replace direct HTTP glue with `new VegaClient({ baseUrl, apiKey })`.
2. Map host events to the canonical request types instead of adapter-local JSON schemas.
3. Register one canonical `surface` value and one stable `host_tier` policy for the adapter.
4. Route retrieval through `contextResolve`, then use the returned `checkpoint_id` and `bundle_digest` in `usageAck`.
5. Remove adapter-local retry or error-normalization code that duplicates the SDK behavior.

## Compatibility window

The formal sunset registry for deprecated Vega surfaces lives at [docs/sunset-registry.yaml](../../sunset-registry.yaml). It is currently empty, which means the migration guidance above is the active source of truth until P8-033 registers concrete sunset candidates.

Once a legacy surface is added there, treat the registry entry as the compatibility clock for that route or pattern. Hosts should migrate before a candidate becomes `ready` under the registry policy.

## Validation

After migration:

- confirm the adapter can ingest, resolve, and ack through the SDK without host-local fetch helpers,
- confirm metrics show traffic on the expected `surface` and `host_tier`,
- confirm reconciliation reports no new drift for the adapter lane,
- confirm alert history stays quiet for the related rule set during a normal traffic window.
