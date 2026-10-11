# app/tests/test_manufacturing_services_retry.py
"""Independent-audit fix: every call in manufacturing_services.py now goes
through the shared _request() helper, which retries a connection-level
failure or a 502/503/504 (the two failure modes that almost always mean
the request never reached the application process) with a short backoff,
and never retries a definite 4xx/5xx application response.

Fully deterministic — httpx.AsyncClient.request is mocked to control
exactly which failures/successes happen on which attempt; no real network
calls, no sleeping the real backoff duration (patched to 0 so these run
fast).
"""
import os
from unittest.mock import AsyncMock, patch

import httpx
import pytest

os.environ.setdefault("INTERNAL_SERVICE_TOKEN", "test-token-for-manufacturing-services-retry-tests")

from app.integrations import manufacturing_services as mfg  # noqa: E402


def _response(status_code: int, json_body: dict | None = None) -> httpx.Response:
    return httpx.Response(status_code, json=json_body or {}, request=httpx.Request("GET", "http://test"))


@pytest.mark.asyncio
async def test_retries_a_connect_error_then_succeeds():
    calls = [httpx.ConnectError("simulated connection refused"), _response(200, {"ok": True})]

    async def fake_request(*args, **kwargs):
        result = calls.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

    with patch("app.integrations.manufacturing_services._RETRY_BACKOFF_SECONDS", (0, 0)), \
         patch.object(httpx.AsyncClient, "request", new=AsyncMock(side_effect=fake_request)):
        resp = await mfg._request("GET", "http://test/thing")

    assert resp.status_code == 200
    assert resp.json() == {"ok": True}


@pytest.mark.asyncio
async def test_retries_a_503_then_succeeds():
    responses = [_response(503), _response(200, {"ok": True})]

    async def fake_request(*args, **kwargs):
        return responses.pop(0)

    with patch("app.integrations.manufacturing_services._RETRY_BACKOFF_SECONDS", (0, 0)), \
         patch.object(httpx.AsyncClient, "request", new=AsyncMock(side_effect=fake_request)):
        resp = await mfg._request("GET", "http://test/thing")

    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_exhausts_retries_and_raises_the_last_connection_error():
    with patch("app.integrations.manufacturing_services._RETRY_BACKOFF_SECONDS", (0, 0)), \
         patch.object(httpx.AsyncClient, "request", new=AsyncMock(side_effect=httpx.ConnectError("still down"))):
        with pytest.raises(httpx.ConnectError):
            await mfg._request("GET", "http://test/thing")


@pytest.mark.asyncio
async def test_never_retries_a_definite_404_even_though_it_is_an_error_status():
    call_count = 0

    async def fake_request(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        return _response(404)

    with patch.object(httpx.AsyncClient, "request", new=AsyncMock(side_effect=fake_request)):
        resp = await mfg._request("GET", "http://test/thing")

    assert resp.status_code == 404
    assert call_count == 1  # the real proof: a definite error response is never retried


@pytest.mark.asyncio
async def test_never_retries_a_definite_500_the_server_genuinely_returned():
    call_count = 0

    async def fake_request(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        return _response(500)

    with patch.object(httpx.AsyncClient, "request", new=AsyncMock(side_effect=fake_request)):
        resp = await mfg._request("GET", "http://test/thing")

    assert resp.status_code == 500
    assert call_count == 1  # a plain 500 means the app DID run — retrying a non-idempotent write here would risk a duplicate


@pytest.mark.asyncio
async def test_a_read_timeout_is_retried_the_same_as_a_connect_error():
    calls = [httpx.ReadTimeout("simulated slow response"), _response(200, {"ok": True})]

    async def fake_request(*args, **kwargs):
        result = calls.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

    with patch("app.integrations.manufacturing_services._RETRY_BACKOFF_SECONDS", (0, 0)), \
         patch.object(httpx.AsyncClient, "request", new=AsyncMock(side_effect=fake_request)):
        resp = await mfg._request("GET", "http://test/thing")

    assert resp.status_code == 200
