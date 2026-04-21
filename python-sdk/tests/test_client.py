import pytest
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
    httpx_mock.add_response(
        method="POST",
        url="https://test.local/ingest_event",
        status_code=400,
        json={"error": "bad_request"},
    )

    with VegaClient("https://test.local") as client:
        with pytest.raises(VegaError) as exc_info:
            client.ingest_event({"event_id": "x"})
        assert exc_info.value.status == 400
        assert "bad_request" in str(exc_info.value)

    assert len(httpx_mock.get_requests()) == 1


def test_api_key_sent_in_authorization_header(httpx_mock: HTTPXMock):
    httpx_mock.add_response(method="POST", url="https://test.local/ingest_event", json={"status": "ok"})

    with VegaClient("https://test.local", api_key="secret") as client:
        client.ingest_event({"event_id": "x"})

    request = httpx_mock.get_requests()[0]
    assert request.headers["authorization"] == "Bearer secret"
