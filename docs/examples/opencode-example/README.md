# OpenCode Example

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
import { VegaClient } from "../../../src/sdk/index.js";

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
