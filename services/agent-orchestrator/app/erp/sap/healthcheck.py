# app/erp/sap/healthcheck.py
"""
Verifies SAP configuration + connectivity WITHOUT creating any business
document — a safe CSRF-token fetch only (a GET request).

Usage:
    python -m app.erp.sap.healthcheck
"""
import sys

from app import config
from app.erp.sap.client import SAPODataClient
from app.erp.sap.errors import ERPError


def check_sap_connection() -> tuple[bool, str]:
    if not (config.SAP_BASE_URL and config.SAP_USERNAME and config.SAP_PASSWORD):
        return False, "SAP_BASE_URL/SAP_USERNAME/SAP_PASSWORD are not all configured."

    client = SAPODataClient(config.SAP_BASE_URL, config.SAP_USERNAME, config.SAP_PASSWORD, config.SAP_TIMEOUT_SECONDS)
    try:
        client.fetch_csrf_token()
        return True, f"Connected to {config.SAP_BASE_URL} and received a CSRF token."
    except ERPError as exc:
        return False, f"{type(exc).__name__}: {exc}"
    finally:
        client.close()


if __name__ == "__main__":
    ok, message = check_sap_connection()
    print(message)
    sys.exit(0 if ok else 1)
