# Claude Code Integration

## Architecture

Claude Code should emit user and tool activity into a local MCP bridge, then forward normalized envelopes to Vega:

`Claude Code -> MCP server -> VegaClient -> POST /ingest_event`

On retrieval turns, the same bridge should call `contextResolve`, inject the returned bundle into the Claude-side prompt/tool context, and finish with `usageAck` after the host knows whether the bundle was sufficient.

## Installation

Install the SDK in the MCP bridge package:

```bash
npm install vega-memory
```

Minimal MCP-side wiring:

```json
{
  "mcpServers": {
    "vega": {
      "command": "node",
      "args": ["dist/mcp/claude-bridge.js"],
      "env": {
        "VEGA_BASE_URL": "http://127.0.0.1:3271",
        "VEGA_API_KEY": "change-me"
      }
    }
  }
}
```

## Event mapping

| Claude Code event | Vega field mapping |
| --- | --- |
| user message | `role=user`, `event_type=message`, `payload.text=...` |
| assistant reply | `role=assistant`, `event_type=message`, `payload.text=...` |
| tool call | `event_type=tool_call`, `payload.tool_name`, `payload.arguments` |
| tool result | `event_type=tool_result`, `payload.tool_name`, `payload.output` |
| attachment or file ref | `artifacts[]` with stable `id`, `kind`, and optional `uri` |

Use the same `session_id` for the visible Claude turn stream and preserve `thread_id` when Claude exposes it.

## Host tier

Claude Code should declare `host_tier: "T1"` on `usage_ack`. It is a real-time, user-facing integration, so timeout handling stays on the soft-presumption path and metrics attribute the tightest UX expectations to Claude traffic.
