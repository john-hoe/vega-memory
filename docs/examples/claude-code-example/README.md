# Claude Code Example

Reference layout:

```text
claude-code-vega/
  package.json
  src/
    index.ts
    envelope-mapper.ts
    mcp-server.ts
  config/
    mcp.json
  .env.example
```

Entry-point sketch:

```ts
import { VegaClient } from "../../../src/sdk/index.js";

const client = new VegaClient({
  baseUrl: process.env.VEGA_BASE_URL ?? "http://127.0.0.1:3271",
  apiKey: process.env.VEGA_API_KEY
});

export async function onClaudeTurn(envelope, intentRequest) {
  await client.ingestEvent(envelope);
  const bundle = await client.contextResolve(intentRequest);
  return { bundle, ack: (sufficiency) => client.usageAck({
    checkpoint_id: bundle.checkpoint_id,
    bundle_digest: bundle.bundle_digest,
    sufficiency,
    host_tier: "T1"
  }) };
}
```

Minimal `mcp.json` fragment:

```json
{
  "vega": {
    "command": "node",
    "args": ["dist/src/index.js"]
  }
}
```
