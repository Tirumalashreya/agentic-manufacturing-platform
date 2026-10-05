# app/tests/test_sap_client.py
"""
Fully deterministic — no network, no credentials. Every SAP response is
faked via httpx.MockTransport, proving the client's error classification
and CSRF handling without needing a real SAP tenant (per the roadmap's
own "HTTP-level tests using mocked SAP responses ... must not require
SAP credentials" rule).
"""
import httpx
import pytest

from app.erp.sap.client import SAPODataClient
from app.erp.sap.errors import (
    ERPAuthenticationError,
    ERPAuthorizationError,
    ERPConflictError,
    ERPNotFoundError,
    ERPRateLimitError,
    ERPTimeoutError,
    ERPUnavailableError,
    ERPValidationError,
)


def _client_with_transport(handler) -> SAPODataClient:
    client = SAPODataClient("https://sap.test", "user", "pass")
    client._client = httpx.Client(
        base_url="https://sap.test", transport=httpx.MockTransport(handler), headers={"Accept": "application/json"},
    )
    return client


def test_fetch_csrf_token_success():
    def handler(request):
        assert request.headers["X-CSRF-Token"] == "Fetch"
        return httpx.Response(200, headers={"x-csrf-token": "abc123"}, json={})

    client = _client_with_transport(handler)
    token = client.fetch_csrf_token()

    assert token == "abc123"


def test_fetch_csrf_token_missing_header_raises_unavailable():
    def handler(request):
        return httpx.Response(200, json={})

    client = _client_with_transport(handler)

    with pytest.raises(ERPUnavailableError):
        client.fetch_csrf_token()


def test_post_reuses_fetched_csrf_token():
    calls = []

    def handler(request):
        calls.append(request)
        if request.method == "GET":
            return httpx.Response(200, headers={"x-csrf-token": "tok-1"}, json={})
        assert request.headers["X-CSRF-Token"] == "tok-1"
        return httpx.Response(201, json={"d": {"SalesOrder": "SO123"}})

    client = _client_with_transport(handler)
    result = client.post("/A_SalesOrder", json={"foo": "bar"})

    assert result == {"d": {"SalesOrder": "SO123"}}
    assert len(calls) == 2  # CSRF fetch, then the real POST


@pytest.mark.parametrize(
    "status,exc_type",
    [
        (401, ERPAuthenticationError),
        (403, ERPAuthorizationError),
        (400, ERPValidationError),
        (404, ERPNotFoundError),
        (409, ERPConflictError),
        (429, ERPRateLimitError),
        (500, ERPUnavailableError),
        (503, ERPUnavailableError),
    ],
)
def test_error_status_codes_map_to_correct_exceptions(status, exc_type):
    def handler(request):
        return httpx.Response(status, json={"error": {"message": {"value": "something went wrong"}}})

    client = _client_with_transport(handler)

    with pytest.raises(exc_type):
        client.get("/A_SalesOrder")


def test_malformed_json_response_raises_unavailable():
    def handler(request):
        return httpx.Response(200, content=b"not json at all")

    client = _client_with_transport(handler)

    with pytest.raises(ERPUnavailableError):
        client.get("/A_SalesOrder")


def test_connect_error_raises_unavailable():
    def handler(request):
        raise httpx.ConnectError("connection refused", request=request)

    client = _client_with_transport(handler)

    with pytest.raises(ERPUnavailableError):
        client.get("/A_SalesOrder")


def test_timeout_raises_erp_timeout_error():
    def handler(request):
        raise httpx.TimeoutException("timed out", request=request)

    client = _client_with_transport(handler)

    with pytest.raises(ERPTimeoutError):
        client.get("/A_SalesOrder")


def test_error_message_extracted_from_sap_error_envelope():
    def handler(request):
        return httpx.Response(400, json={"error": {"message": {"value": "Material is not valid"}}})

    client = _client_with_transport(handler)

    with pytest.raises(ERPValidationError, match="Material is not valid"):
        client.get("/A_SalesOrder")
