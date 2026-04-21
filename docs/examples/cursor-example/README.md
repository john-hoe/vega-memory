# Cursor Example

Reference layout:

```text
cursor-vega/
  package.json
  src/
    extension.ts
    vega-adapter.ts
    settings.ts
  .vscode/
    settings.json
  .env.example
```

Entry-point sketch:

```ts
import { VegaClient } from "../../../src/sdk/index.js";

const client = new VegaClient({
  baseUrl: process.env.VEGA_BASE_URL ?? "http://127.0.0.1:3271",
  apiKey: process.env.VEGA_API_KEY
});

export async function runCursorFlow(envelope, intentRequest) {
  await client.ingestEvent(envelope);
  const result = await client.contextResolve(intentRequest);
  await client.usageAck({
    checkpoint_id: result.checkpoint_id,
    bundle_digest: result.bundle_digest,
    sufficiency: "sufficient",
    host_tier: "T2"
  });
  return result.bundle;
}
```

Minimal workspace config:

```json
{
  "vega.baseUrl": "http://127.0.0.1:3271",
  "vega.surface": "cursor"
}
```
