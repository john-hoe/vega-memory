"""Vega Memory HTTP client with 3x retry on 5xx/network."""

import time
from typing import Any

import httpx


class VegaError(Exception):
    """Structured error from Vega API."""

    def __init__(self, status: int, message: str, body: dict[str, Any] | None = None):
        super().__init__(f"[{status}] {message}")
        self.status = status
        self.message = message
        self.body = body or {}


class VegaClient:
    """Minimal TypeScript SDK parity - ingest_event / context_resolve / usage_ack."""

    MAX_ATTEMPTS = 3

    def __init__(
        self,
        base_url: str,
        *,
        api_key: str | None = None,
        timeout_seconds: float = 30.0,
        client: httpx.Client | None = None,
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

    def ingest_event(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._post("/ingest_event", payload)

    def context_resolve(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._post("/context_resolve", payload)

    def usage_ack(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._post("/usage_ack", payload)

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        last_err: Exception | None = None
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


def _safe_json(resp: httpx.Response) -> dict[str, Any]:
    try:
        return resp.json()
    except ValueError:
        return {"raw": resp.text}
