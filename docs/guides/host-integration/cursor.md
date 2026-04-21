# Cursor Integration

## Architecture

Cursor fits Vega best as a plugin-side event adapter:

`Cursor extension -> adapter process -> VegaClient -> ingest/context/ack`

The extension captures editor and chat events, the adapter normalizes them into Vega envelopes, and retrieval calls happen before the extension renders the final assistant response or command result.

## Installation

Install the SDK in the adapter package and expose Vega connection details through extension settings or environment variables:

```bash
npm install vega-memory
```

Suggested adapter config:

```json
{
  "vega.baseUrl": "http://127.0.0.1:3271",
  "vega.apiKeyEnv": "VEGA_API_KEY",
  "vega.surface": "cursor"
}
```

## Event mapping

| Cursor source | Vega field mapping |
| --- | --- |
| chat prompt | `role=user`, `event_type=message`, `payload.text` |
| generated completion | `role=assistant`, `event_type=message`, `payload.text` |
| command palette or slash command | `event_type=tool_call`, `payload.command` |
| code edit or apply step | `event_type=tool_result`, `payload.file_paths`, `payload.summary` |
| active workspace | `project`, `cwd`, `session_id` seeded from the extension workspace context |

Emit artifacts when the extension can point to concrete files or diffs. Keep `surface: "cursor"` stable across both ingest and retrieval calls.

## Host tier

Cursor should generally declare `host_tier: "T2"` on `usage_ack`. It is still interactive, but the user can recover from transient retrieval misses through editor context and repeated requests, so the timeout path stays softer than backend workers while remaining distinguishable from `T1`.
