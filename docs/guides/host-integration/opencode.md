# OpenCode Integration

## Architecture

OpenCode is typically a backend-agent integration:

`OpenCode orchestrator -> adapter worker -> VegaClient -> ingest/context/ack`

The worker should batch host events into envelopes, resolve retrieval context before execution-heavy steps, and acknowledge bundle usefulness after the worker has a clear outcome for the turn.

## Installation

Install the SDK in the OpenCode adapter package:

```bash
npm install vega-memory
```

Import the client from the package entrypoint in the worker or adapter process:

```ts
import { VegaClient } from "vega-memory";
```

Minimal adapter boot config:

```json
{
  "vega": {
    "baseUrl": "http://127.0.0.1:3271",
    "apiKeyEnv": "VEGA_API_KEY",
    "surface": "api"
  }
}
```

## Event mapping

| OpenCode event | Vega field mapping |
| --- | --- |
| queued task | `event_type=message`, `payload.task`, `role=user` |
| planner decision | `event_type=message`, `role=assistant`, `payload.plan` |
| tool invocation | `event_type=tool_call`, `payload.tool_name`, `payload.arguments` |
| worker output | `event_type=tool_result`, `payload.output`, `artifacts[]` for files or logs |
| background retry metadata | `payload.retry_count`, `payload.worker_id`, optional `project` and `cwd` |

For long-running jobs, keep `session_id` stable for the whole orchestration lane and only acknowledge a bundle after the worker decides whether follow-up is needed.

## Host tier

OpenCode should usually declare `host_tier: "T3"` on `usage_ack`. It behaves like a backend worker, so Vega’s timeout policy treats expiry as a hard failure and downstream troubleshooting should check reconciliation and alert lanes first.
