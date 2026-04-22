# Cursor Example

> **Blueprint only** — this directory contains architecture sketches, directory
> layouts, and configuration file shapes. It does NOT contain runnable code.
> Runnable example repositories are a separate deliverable (not shipped as of
> 2026-04-21). Use these blueprints to scaffold an integration; do not expect
> `npm install` + `npm run` to work from here.

Install the SDK with `npm install vega-memory`, then import it from the package entrypoint.

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

Entry-point sketch — host is thin; Vega owns memory intelligence:

```ts
import { createEnvelopeBuilder, validateTransportEnvelope } from "vega-memory";

export async function runCursorFlow(rawEvent, sessionId) {
  // Host responsibility: build a transport envelope
  const envelope = createEnvelopeBuilder({
    surface: "cursor",
    session_id: sessionId,
    role: rawEvent.role,
    event_type: rawEvent.type,
    thread_id: rawEvent.threadId ?? null
  })
    .setPayload(rawEvent.payload)
    .setSafety({ redacted: false, categories: [] })
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

Minimal workspace config:

```json
{
  "vega.baseUrl": "http://127.0.0.1:3271",
  "vega.surface": "cursor"
}
```
