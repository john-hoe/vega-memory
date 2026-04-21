# Batch 31a — Close 🟡 P8-041: Python SDK parity

## Context

🟡 P8-041: TypeScript SDK shipped in 21a (`src/sdk/vega-client.ts`). Python SDK per original brief 21a description was always part of P8-041 scope but remained deferred. This batch ships minimal Python parity.

Package layout (new sibling tree — Python doesn't belong under `src/` which is JS/TS):

```
python-sdk/
  pyproject.toml
  README.md
  src/
    vega_memory/
      __init__.py
      client.py
  tests/
    test_client.py
```

Package name: `vega-memory` (Python; PyPI-compatible). Distinct from npm package namespace but consistent brand.

No amend — new commit on HEAD (parent = `3a2b832`).

## Scope

### 1. `python-sdk/pyproject.toml` — minimal package definition

```toml
[project]
name = "vega-memory"
version = "0.1.0"
description = "Python SDK for Vega Memory (ingest, context, ack)"
readme = "README.md"
requires-python = ">=3.10"
dependencies = [
  "httpx>=0.27.0"
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/vega_memory"]

[project.optional-dependencies]
test = ["pytest>=8.0.0", "pytest-httpx>=0.30.0"]
```

Use `hatchling` (simpler than setuptools) + `httpx` (sync + async HTTP).

### 2. `python-sdk/src/vega_memory/__init__.py`

```python
"""Vega Memory Python SDK."""

from vega_memory.client import VegaClient, VegaError

__all__ = ["VegaClient", "VegaError"]
__version__ = "0.1.0"
```

### 3. `python-sdk/src/vega_memory/client.py` — thin SDK (≤ 200 lines)

```python
"""Vega Memory HTTP client with 3x retry on 5xx/network."""

import time
from typing import Any, Dict, Optional

import httpx


class VegaError(Exception):
    """Structured error from Vega API."""
    def __init__(self, status: int, message: str, body: Optional[Dict[str, Any]] = None):
        super().__init__(f"[{status}] {message}")
        self.status = status
        self.message = message
        self.body = body or {}


class VegaClient:
    """Minimal TypeScript SDK parity — ingest_event / context_resolve / usage_ack.

    - 3x retry on 5xx / network errors with exponential backoff
    - Raises VegaError immediately on 4xx (no retry on client errors)
    """

    MAX_ATTEMPTS = 3

    def __init__(
        self,
        base_url: str,
        *,
        api_key: Optional[str] = None,
        timeout_seconds: float = 30.0,
        client: Optional[httpx.Client] = None
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout_seconds = timeout_seconds
        self._client = client or httpx.Client(timeout=timeout_seconds)
        self._owned_client = client is None

    def close(self) -> None:
        if self._owned_client:
            self._client.close()

    def __enter__(self) -> "VegaClient":
        return self

    def __exit__(self, *exc_info: Any) -> None:
        self.close()

    def ingest_event(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self._post("/ingest_event", payload)

    def context_resolve(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self._post("/context_resolve", payload)

    def usage_ack(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self._post("/usage_ack", payload)

    def _post(self, path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        url = f"{self.base_url}{path}"
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        last_err: Optional[Exception] = None
        for attempt in range(1, self.MAX_ATTEMPTS + 1):
            try:
                resp = self._client.post(url, json=payload, headers=headers)
            except httpx.NetworkError as exc:
                last_err = exc
                if attempt < self.MAX_ATTEMPTS:
                    time.sleep(0.1 * (2 ** (attempt - 1)))
                    continue
                raise VegaError(0, f"network_error: {exc}") from exc

            if 500 <= resp.status_code < 600:
                last_err = VegaError(resp.status_code, resp.text or "server_error")
                if attempt < self.MAX_ATTEMPTS:
                    time.sleep(0.1 * (2 ** (attempt - 1)))
                    continue
                raise last_err

            if 400 <= resp.status_code < 500:
                body = _safe_json(resp)
                raise VegaError(resp.status_code, body.get("error", resp.text or "client_error"), body)

            return _safe_json(resp)

        if last_err:
            raise last_err
        raise VegaError(0, "retry_exhausted")


def _safe_json(resp: httpx.Response) -> Dict[str, Any]:
    try:
        return resp.json()
    except ValueError:
        return {"raw": resp.text}
```

Target: ≤ 200 lines (count LoC). Mirror TypeScript SDK `vega-client.ts` semantics exactly.

### 4. `python-sdk/README.md` — quick-start guide

```md
# Vega Memory Python SDK

Minimal Python client for the Vega Memory API.

## Install

\`\`\`bash
pip install vega-memory
\`\`\`

## Quick start

\`\`\`python
from vega_memory import VegaClient

with VegaClient(base_url="https://vega.example.com", api_key="...") as client:
    result = client.ingest_event({
        "source_kind": "vega_memory",
        "event_id": "evt-1",
        "session_id": "session-a",
        "project": "my-project"
    })
    print(result)
\`\`\`

## Retry policy

- 3 attempts on 5xx or network errors (exponential backoff: 100ms, 200ms, 400ms)
- Immediate raise on 4xx (client errors — no retry)
- Raises `VegaError` with structured `.status` / `.message` / `.body`

## Parity notes

- Functional parity with TypeScript SDK in `src/sdk/vega-client.ts`
- Public surface: `VegaClient(base_url, api_key?, timeout_seconds?, client?)` + `ingest_event` / `context_resolve` / `usage_ack` methods + `VegaError`
```

### 5. `python-sdk/tests/test_client.py` — pytest suite ≥ 6 cases

Use `pytest-httpx` to stub HTTP responses:

```python
import pytest
import httpx
from pytest_httpx import HTTPXMock

from vega_memory import VegaClient, VegaError


def test_ingest_event_happy_path(httpx_mock: HTTPXMock):
    httpx_mock.add_response(method="POST", url="https://test.local/ingest_event", json={"status": "ok"})

    with VegaClient("https://test.local") as client:
        result = client.ingest_event({"event_id": "x"})
        assert result == {"status": "ok"}


def test_context_resolve_happy_path(httpx_mock: HTTPXMock):
    httpx_mock.add_response(method="POST", url="https://test.local/context_resolve", json={"bundle": []})

    with VegaClient("https://test.local") as client:
        result = client.context_resolve({"profile": "bootstrap"})
        assert result == {"bundle": []}


def test_usage_ack_happy_path(httpx_mock: HTTPXMock):
    httpx_mock.add_response(method="POST", url="https://test.local/usage_ack", json={"ack": True})

    with VegaClient("https://test.local") as client:
        result = client.usage_ack({"checkpoint_id": "abc"})
        assert result == {"ack": True}


def test_retry_on_5xx_eventually_succeeds(httpx_mock: HTTPXMock):
    httpx_mock.add_response(method="POST", url="https://test.local/ingest_event", status_code=503)
    httpx_mock.add_response(method="POST", url="https://test.local/ingest_event", status_code=503)
    httpx_mock.add_response(method="POST", url="https://test.local/ingest_event", json={"status": "ok"})

    with VegaClient("https://test.local") as client:
        result = client.ingest_event({"event_id": "x"})
        assert result == {"status": "ok"}


def test_retry_exhaustion_raises(httpx_mock: HTTPXMock):
    for _ in range(3):
        httpx_mock.add_response(method="POST", url="https://test.local/ingest_event", status_code=503)

    with VegaClient("https://test.local") as client:
        with pytest.raises(VegaError) as exc_info:
            client.ingest_event({"event_id": "x"})
        assert exc_info.value.status == 503


def test_4xx_immediate_raise_no_retry(httpx_mock: HTTPXMock):
    httpx_mock.add_response(method="POST", url="https://test.local/ingest_event", status_code=400, json={"error": "bad_request"})

    with VegaClient("https://test.local") as client:
        with pytest.raises(VegaError) as exc_info:
            client.ingest_event({"event_id": "x"})
        assert exc_info.value.status == 400
        assert "bad_request" in str(exc_info.value)

    # Only 1 request made (no retry on 4xx)
    assert len(httpx_mock.get_requests()) == 1


def test_api_key_sent_in_authorization_header(httpx_mock: HTTPXMock):
    httpx_mock.add_response(method="POST", url="https://test.local/ingest_event", json={"status": "ok"})

    with VegaClient("https://test.local", api_key="secret") as client:
        client.ingest_event({"event_id": "x"})

    request = httpx_mock.get_requests()[0]
    assert request.headers["authorization"] == "Bearer secret"
```

Total: 7 tests. All hermetic (stubbed HTTP; no real network).

### 6. Update existing TS docs to reference Python SDK

In `docs/guides/host-integration/README.md`, add a short "Python SDK" section or footnote:

```md
## Python SDK

For Python integrations, install the sibling package:

\`\`\`bash
pip install vega-memory
\`\`\`

See [python-sdk/README.md](../../../python-sdk/README.md) for usage.
```

### 7. Root-level npm ignore

Add `python-sdk/` to `.npmignore` / `.gitignore`-like scope for the TS package. Actually — `python-sdk/` at repo root should NOT ship with the npm package. Check `package.json` files field or `.npmignore`:

If `package.json` has a `files` allowlist, Python SDK won't ship automatically. If it doesn't, add `.npmignore` with `python-sdk/`.

Don't touch `package.json` unless absolutely needed; prefer `.npmignore` addition.

## Out of scope — do NOT touch

- Everything in `src/` EXCEPT `src/sdk/` (already sealed) and maybe indirect test references — don't touch for this batch
- `package.json` unless `.npmignore` approach doesn't work (prefer `.npmignore`)
- `.eslintrc.cjs`, `src/tests/**`
- All prior-sealed modules
- `docs/adapters/**`, `docs/architecture/**`
- `docs/briefs/` (other than this brief)

Allowed:
- `python-sdk/**` (new directory tree)
- `docs/guides/host-integration/README.md` (add Python SDK section)
- `.npmignore` (new or update)

## Forbidden patterns

- Python SDK MUST be pure Python (no Node.js imports, no TS)
- Python tests MUST stub HTTP (pytest-httpx); no real network
- NO amend of prior commits — new commit on HEAD (parent = `3a2b832`)
- Python package MUST NOT depend on anything not in `pyproject.toml` declared
- Python SDK version = "0.1.0" (first release)
- TypeScript SDK (`src/sdk/vega-client.ts`) unchanged — parity means Python copies TS, not vice-versa

## Acceptance criteria

1. `python-sdk/pyproject.toml` exists with `name = "vega-memory"` and `version = "0.1.0"`
2. `python-sdk/src/vega_memory/__init__.py` exports `VegaClient` + `VegaError`
3. `python-sdk/src/vega_memory/client.py` exists; line count ≤ 200 (via `wc -l`)
4. `python-sdk/src/vega_memory/client.py` contains all 3 methods: `ingest_event` / `context_resolve` / `usage_ack` (grep)
5. `python-sdk/src/vega_memory/client.py` retry logic for 5xx (grep `500 <= resp.status_code < 600` OR `range(1, .*+1)` loop marker)
6. `python-sdk/src/vega_memory/client.py` raises on 4xx (grep `400 <= resp.status_code`)
7. `python-sdk/tests/test_client.py` has ≥ 7 test functions (`rg -c "^def test_"`)
8. `python-sdk/README.md` exists with Quick start + Retry policy sections
9. `docs/guides/host-integration/README.md` references Python SDK
10. `git diff HEAD --name-only` new files under `python-sdk/` only; maybe `.npmignore` and `docs/guides/host-integration/README.md`
11. `git diff HEAD -- src/` outputs empty (no TS source touched)
12. `set -o pipefail; npm run build` exits 0; `set -o pipefail; npm test` ≥ 1255 pass / 0 fail (no TS test change)
13. Python tests runnable (though not required to be part of npm test): optionally run `pip install -e python-sdk[test] && pytest python-sdk/tests` to verify — document result in commit body if ran
14. `npm run lint:readonly-guard` exits 0
15. Not-amend; parent of new commit = `3a2b832`
16. Commit title prefix `feat(sdk):` (Python SDK dominates)
17. Commit body:
    ```
    Close 🟡 P8-041: Python SDK parity.

    Ships python-sdk/ sibling to the TypeScript SDK (src/sdk/).
    Package name: vega-memory (Python). Functional parity:
    - VegaClient(base_url, api_key?, timeout_seconds?, client?)
    - ingest_event / context_resolve / usage_ack methods
    - VegaError with structured status / message / body
    - 3x retry on 5xx + network errors (exponential backoff)
    - Immediate raise on 4xx (no retry on client errors)

    Package structure:
    - python-sdk/pyproject.toml (hatchling + httpx dep)
    - python-sdk/src/vega_memory/{__init__.py, client.py} (≤ 200 LoC)
    - python-sdk/tests/test_client.py (7 hermetic cases via pytest-httpx)
    - python-sdk/README.md (quick-start + retry policy)

    Related docs:
    - docs/guides/host-integration/README.md: Python SDK section added
    - .npmignore: python-sdk/ excluded from npm package

    Scope: pure additive — new sibling directory + 1 README doc edit +
    maybe .npmignore. Zero TS source changes.

    Scope-risk: minimal (parallel SDK; no TS behavior change)
    Reversibility: clean (delete python-sdk/ directory)
    ```

## Review checklist

- Python SDK ≤ 200 LoC?
- Package name exactly `vega-memory` in pyproject.toml?
- Retry semantics: 3 attempts, 5xx retries, 4xx immediate raise?
- Exponential backoff present (not a fixed sleep)?
- `VegaError` has `status` / `message` / `body` attributes?
- 7+ pytest cases (happy paths for 3 methods + retry success + retry exhaustion + 4xx no-retry + auth header)?
- `pytest-httpx` used for HTTP stubbing (no real network)?
- `docs/guides/host-integration/README.md` references python-sdk?
- `.npmignore` excludes python-sdk/?
- New commit stacks on `3a2b832` (not amend)?

## Commit discipline

- Single atomic commit
- Prefix `feat(sdk):`
- Body per Acceptance #17
- Files changed: new `python-sdk/` tree (7 files) + maybe `.npmignore` + `docs/guides/host-integration/README.md`
