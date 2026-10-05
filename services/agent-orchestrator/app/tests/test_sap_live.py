# app/tests/test_sap_live.py
"""
Live tests against a REAL SAP S/4HANA Cloud tenant. Off by default —
every test in this file is skipped unless SAP_INTEGRATION_TESTS=true AND
the required SAP_* environment variables are actually set. This file
requires zero configuration to exist safely in the repo; it simply does
nothing until someone deliberately opts in with real credentials.

Test sequence follows the roadmap's own ordering: connectivity first,
then a real (but clearly test-scoped) create — never jump straight to
creating a document against an unverified connection.
"""
import pytest

from app import config

pytestmark = pytest.mark.skipif(
    not config.SAP_INTEGRATION_TESTS,
    reason="SAP_INTEGRATION_TESTS is not enabled — set it (and the SAP_* env vars) to run live SAP tests.",
)


def test_sap_connectivity():
    from app.erp.sap.healthcheck import check_sap_connection

    ok, message = check_sap_connection()

    assert ok, message


@pytest.mark.skipif(
    not (config.SAP_TEST_CUSTOMER and config.SAP_TEST_MATERIAL),
    reason="SAP_TEST_CUSTOMER and SAP_TEST_MATERIAL must be set to run a real create test.",
)
def test_create_real_sales_order_against_test_tenant():
    from app.erp.sap.adapter import SAPAdapter

    adapter = SAPAdapter()
    quantity = int(config.SAP_TEST_QUANTITY or "1")

    result = adapter.create_sales_order(
        customer_id=config.SAP_TEST_CUSTOMER,
        customer_name="SAP live test",
        customer_active=True,
        product_id=config.SAP_TEST_MATERIAL,
        product_name="SAP live test material",
        quantity=quantity,
        unit_price=1.0,
        requested_deadline=None,
    )

    assert result["created"] is True
    assert result["sales_order_id"]
