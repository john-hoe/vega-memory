# Host Integration Guide

## Quick start

Install the SDK with `npm install vega-memory`, then import it from the published package entrypoint:

```ts
import { VegaClient } from "vega-memory";
const client = new VegaClient({ baseUrl: "http://127.0.0.1:3271", apiKey: process.env.VEGA_API_KEY });
await client.ingestEvent(envelope);
const resolved = await client.contextResolve(intentRequest);
await client.usageAck({ checkpoint_id: resolved.checkpoint_id, bundle_digest: resolved.bundle_digest, sufficiency: "sufficient", host_tier: "T2" });
```

## Python SDK

For Python integrations, install the sibling package:

```bash
pip install vega-memory
```

See [python-sdk/README.md](../../../python-sdk/README.md) for usage.

## Surface registration

Every host adapter should register two stable identities with Vega: `surface` on the event envelope or intent request, and `host_tier` on `usage_ack`.

Use `host_tier` consistently:

| Tier | Typical host | Downstream effect |
| --- | --- | --- |
| `T1` | real-time user-facing host | Timeout policy treats expiry as presumed-sufficient, and usage metrics show the host on the highest-trust lane. |
| `T2` | interactive assistant with some recovery room | Timeout policy is still presumed-sufficient, but metrics and follow-up volume remain attributable to the host. |
| `T3` | backend or batch worker | Timeout policy treats expiry as hard-failure, so reconciliation and alert review should assume stricter delivery requirements. |

Keep the `surface` value aligned with the canonical enums already used by envelopes and intent requests. Do not invent adapter-local aliases.

## Example integrations

- [Claude Code](./claude-code.md)
- [Cursor](./cursor.md)
- [OpenCode](./opencode.md)
- [Example repo stubs](../../examples/README.md)
- [Troubleshooting](./troubleshooting.md)
- [Migration](./migration.md)

## API reference

- `POST /ingest_event` accepts `HostEventEnvelopeV1` and returns `IngestEventResponse`.
- `POST /context_resolve` accepts `IntentRequest` and returns `ContextResolveResponse`.
- `POST /usage_ack` accepts `UsageAck` and returns `UsageAckResponse`.
- The `vega-memory` package re-exports the request aliases plus `VegaClient`, `VegaClientError`, and the existing response types from the server implementation.
