# OpenCode Example

> **Blueprint only** — this directory contains architecture sketches, directory
> layouts, and configuration file shapes. It does NOT contain runnable code.
> Runnable example repositories are a separate deliverable (not shipped as of
> 2026-04-21). Use these blueprints to scaffold an integration; do not expect
> `npm install` + `npm run` to work from here.

Install the SDK with `npm install vega-memory`, then import it from the package entrypoint.

Reference layout:

```text
opencode-vega/
  package.json
  src/
    worker.ts
    event-bridge.ts
    retrieval.ts
  config/
    opencode.json
  .env.example
```

Entry-point sketch:

```ts
import { VegaClient } from "vega-memory";

const client = new VegaClient({
  baseUrl: process.env.VEGA_BASE_URL ?? "http://127.0.0.1:3271",
  apiKey: process.env.VEGA_API_KEY
});

export async function runWorkerTurn(envelope, intentRequest) {
  await client.ingestEvent(envelope);
  const bundle = await client.contextResolve(intentRequest);
  await client.usageAck({
    checkpoint_id: bundle.checkpoint_id,
    bundle_digest: bundle.bundle_digest,
    sufficiency: "needs_followup",
    host_tier: "T3"
  });
  return bundle;
}
```

Minimal worker config:

```json
{
  "vega": {
    "baseUrl": "http://127.0.0.1:3271",
    "surface": "api"
  }
}
```
