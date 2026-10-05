# app/erp/sap/client.py
"""
A thin SAP OData V2 HTTP client — authentication, CSRF token handling,
timeouts, and error classification. No business logic lives here (no
concept of a "Sales Order" or a "Material") — see mapper.py and
adapter.py for that. This only knows how to talk to *an* OData V2
service safely.

CSRF handling follows SAP's own documented OData V2 pattern: a safe GET
with header X-CSRF-Token: Fetch returns a token (and session cookies,
which httpx.Client keeps automatically across requests on the same
client instance) that every state-changing request must echo back in
the same header.
"""
import httpx

from app.erp.sap.errors import (
    ERPAuthenticationError,
    ERPAuthorizationError,
    ERPConflictError,
    ERPError,
    ERPNotFoundError,
    ERPRateLimitError,
    ERPTimeoutError,
    ERPUnavailableError,
    ERPValidationError,
)


class SAPODataClient:
    def __init__(self, base_url: str, username: str, password: str, timeout: float = 30.0):
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"),
            auth=(username, password),
            timeout=timeout,
            headers={"Accept": "application/json"},
        )
        self._csrf_token: str | None = None

    def fetch_csrf_token(self) -> str:
        response = self._request("GET", "/", headers={"X-CSRF-Token": "Fetch"})
        token = response.headers.get("x-csrf-token")
        if not token:
            raise ERPUnavailableError(
                "SAP responded but did not return an X-CSRF-Token header — "
                "this service may not be a standard OData V2 endpoint, or CSRF "
                "protection is configured differently for this tenant."
            )
        self._csrf_token = token
        return token

    def get(self, path: str) -> dict:
        response = self._request("GET", path)
        return self._parse_json(response)

    def post(self, path: str, json: dict) -> dict:
        if self._csrf_token is None:
            self.fetch_csrf_token()
        response = self._request(
            "POST", path, json=json,
            headers={"X-CSRF-Token": self._csrf_token, "Content-Type": "application/json"},
        )
        return self._parse_json(response)

    def close(self) -> None:
        self._client.close()

    # --- internal ---

    def _request(self, method: str, path: str, **kwargs) -> httpx.Response:
        try:
            response = self._client.request(method, path, **kwargs)
        except httpx.TimeoutException as exc:
            raise ERPTimeoutError(f"SAP request timed out ({method} {path}): {exc}") from exc
        except httpx.ConnectError as exc:
            raise ERPUnavailableError(f"Could not reach SAP ({method} {path}): {exc}") from exc
        except httpx.HTTPError as exc:
            raise ERPUnavailableError(f"SAP request failed ({method} {path}): {exc}") from exc
        self._raise_for_status(response)
        return response

    def _parse_json(self, response: httpx.Response) -> dict:
        try:
            return response.json()
        except ValueError as exc:
            raise ERPUnavailableError(f"SAP returned a response that was not valid JSON: {exc}") from exc

    def _raise_for_status(self, response: httpx.Response) -> None:
        if response.status_code < 400:
            return
        detail = self._extract_error_message(response)
        status = response.status_code
        if status == 401:
            raise ERPAuthenticationError(detail)
        if status == 403:
            raise ERPAuthorizationError(detail)
        if status == 400:
            raise ERPValidationError(detail)
        if status == 404:
            raise ERPNotFoundError(detail)
        if status == 409:
            raise ERPConflictError(detail)
        if status == 429:
            raise ERPRateLimitError(detail)
        if status >= 500:
            raise ERPUnavailableError(detail)
        raise ERPError(f"Unexpected SAP response ({status}): {detail}")

    def _extract_error_message(self, response: httpx.Response) -> str:
        # SAP OData V2's standard error envelope: {"error": {"message": {"value": "..."}}}
        try:
            body = response.json()
            message = body.get("error", {}).get("message", {})
            if isinstance(message, dict):
                return message.get("value") or str(body)
            return str(message) or str(body)
        except ValueError:
            return response.text[:500] if response.text else f"HTTP {response.status_code}"
