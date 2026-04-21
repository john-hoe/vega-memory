# Vega Memory Python SDK

Minimal Python client for the Vega Memory API.

## Install

```bash
pip install vega-memory
```

## Quick start

```python
from vega_memory import VegaClient

with VegaClient(base_url="https://vega.example.com", api_key="...") as client:
    result = client.ingest_event(
        {
            "source_kind": "vega_memory",
            "event_id": "evt-1",
            "session_id": "session-a",
            "project": "my-project",
        }
    )
    print(result)
```

## Retry policy

- 3 attempts on 5xx or network errors (exponential backoff: 100ms, 200ms, 400ms)
- Immediate raise on 4xx (client errors - no retry)
- Raises `VegaError` with structured `.status` / `.message` / `.body`

## Parity notes

- Functional parity with TypeScript SDK in `src/sdk/vega-client.ts`
- Public surface: `VegaClient(base_url, api_key?, timeout_seconds?, client?)` + `ingest_event` / `context_resolve` / `usage_ack` methods + `VegaError`
