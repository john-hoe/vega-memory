# Claude Code Example

> **Blueprint only** — this directory contains architecture sketches, directory
> layouts, and configuration file shapes. It does NOT contain runnable code.
> Runnable example repositories are a separate deliverable (not shipped as of
> 2026-04-21). Use these blueprints to scaffold an integration; do not expect
> `npm install` + `npm run` to work from here.

Install the SDK with `npm install vega-memory`, then import it from the package entrypoint.

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

Entry-point sketch — host is thin; Vega owns memory intelligence:

```ts
import { createEnvelopeBuilder, validateTransportEnvelope } from "vega-memory";

export async function onClaudeTurn(rawEvent, sessionId) {
  // Host responsibility: build a transport envelope
  const envelope = createEnvelopeBuilder({
    surface: "claude",
    session_id: sessionId,
    role: rawEvent.role,
    event_type: rawEvent.type,
    project: process.env.VEGA_PROJECT ?? null,
    cwd: process.cwd()
  })
    .setPayload(rawEvent.payload)
    .build();

  // Host responsibility: validate before sending
  const v = validateTransportEnvelope(envelope);
  if (!v.valid) throw new Error(`Invalid envelope: ${v.errors.join(", ")}`);

  // Host responsibility: store / retrieve / use
  await vegaClient.ingestEvent(envelope);
  const bundle = await vegaClient.contextResolve(rawEvent.intent);
  return { bundle };
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
