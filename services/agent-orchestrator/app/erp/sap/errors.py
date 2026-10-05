# app/erp/sap/errors.py
"""
Application-level errors the SAP adapter raises instead of ever letting a
raw httpx/SAP exception (or a raw SAP OData error body) reach the
business layer. The business layer catches these, never SAP-specific
types — that boundary is what keeps graph.py/agents ignorant of SAP.
"""


class ERPError(Exception):
    """Base class for every error an ERPAdapter implementation can raise."""


class ERPNotConfiguredError(ERPError):
    """
    Raised by SAPAdapter.__init__ when required configuration
    (SAP_BASE_URL/SAP_USERNAME/SAP_PASSWORD) is missing. Deliberately
    distinct from every other ERPError below — this is a setup problem,
    not something SAP itself returned, and it must never be papered over
    by returning a fake success.
    """


class ERPAuthenticationError(ERPError):
    """SAP rejected the credentials (HTTP 401)."""


class ERPAuthorizationError(ERPError):
    """SAP accepted the credentials but refused the operation (HTTP 403)."""


class ERPValidationError(ERPError):
    """SAP rejected the request as invalid (HTTP 400), or this adapter
    refused to send an incomplete/unsafe payload before even calling SAP."""


class ERPNotFoundError(ERPError):
    """SAP has no record matching the request (HTTP 404)."""


class ERPConflictError(ERPError):
    """SAP rejected the request due to a conflicting/stale state (HTTP 409)."""


class ERPRateLimitError(ERPError):
    """SAP is throttling this client (HTTP 429)."""


class ERPUnavailableError(ERPError):
    """SAP could not be reached, or returned a server error (HTTP 5xx),
    or returned something this client could not parse as a valid response."""


class ERPTimeoutError(ERPError):
    """The request to SAP timed out — the real SAP-side outcome is
    unknown, so this must NOT be treated the same as a clean failure
    (see the idempotency note in app/erp/sap/adapter.py)."""
