# app/tests/test_sap_adapter.py
"""
Fully deterministic — no network, no credentials, no LLM. Uses
monkeypatch to set SAP config values and httpx.MockTransport to fake SAP
responses, proving SAPAdapter's behavior without ever touching a real
SAP tenant.
"""
import httpx
import pytest

from app.erp.sap.errors import ERPNotConfiguredError


def _configure(monkeypatch, **overrides):
    defaults = dict(
        SAP_BASE_URL="https://sap.test",
        SAP_USERNAME="user",
        SAP_PASSWORD="pass",
        SAP_SALES_ORGANIZATION="1710",
        SAP_DISTRIBUTION_CHANNEL="10",
        SAP_ORGANIZATION_DIVISION="00",
        SAP_SALES_ORDER_TYPE="OR",
        SAP_TRANSACTION_CURRENCY="USD",
        SAP_DRY_RUN=False,
    )
    defaults.update(overrides)
    for key, value in defaults.items():
        monkeypatch.setattr(f"app.config.{key}", value)


def test_raises_not_configured_without_credentials(monkeypatch):
    _configure(monkeypatch, SAP_BASE_URL=None)

    from app.erp.sap.adapter import SAPAdapter

    with pytest.raises(ERPNotConfiguredError):
        SAPAdapter()


def test_dry_run_never_sends_request_and_returns_payload(monkeypatch):
    _configure(monkeypatch, SAP_DRY_RUN=True)

    from app.erp.sap.adapter import SAPAdapter

    adapter = SAPAdapter()
    result = adapter.create_sales_order(
        customer_id="10000123", customer_name="Test Customer", customer_active=True,
        product_id="TG12", product_name="Test Material", quantity=5, unit_price=100.0,
        requested_deadline=None,
    )

    assert result["created"] is False
    assert "SAP_DRY_RUN" in result["reason"]
    assert "10000123" in result["reason"]


def test_create_sales_order_success(monkeypatch):
    _configure(monkeypatch)
    from app.erp.sap.adapter import SAPAdapter

    adapter = SAPAdapter()

    def handler(request):
        if request.method == "GET":
            return httpx.Response(200, headers={"x-csrf-token": "tok"}, json={})
        return httpx.Response(201, json={"d": {"SalesOrder": "3000045"}})

    adapter._client._client = httpx.Client(
        base_url="https://sap.test", transport=httpx.MockTransport(handler), headers={"Accept": "application/json"},
    )

    result = adapter.create_sales_order(
        customer_id="10000123", customer_name="Test Customer", customer_active=True,
        product_id="TG12", product_name="Test Material", quantity=5, unit_price=100.0,
        requested_deadline=None,
    )

    assert result == {"created": True, "sales_order_id": "3000045", "status": "CONFIRMED", "total_amount": 500.0}


def test_create_sales_order_rejects_inactive_customer_before_calling_sap(monkeypatch):
    _configure(monkeypatch)
    from app.erp.sap.adapter import SAPAdapter

    adapter = SAPAdapter()

    def handler(request):
        raise AssertionError("SAP should not be called for an inactive customer")

    adapter._client._client = httpx.Client(
        base_url="https://sap.test", transport=httpx.MockTransport(handler), headers={"Accept": "application/json"},
    )

    result = adapter.create_sales_order(
        customer_id="10000123", customer_name="Test Customer", customer_active=False,
        product_id="TG12", product_name="Test Material", quantity=5, unit_price=100.0,
        requested_deadline=None,
    )

    assert result["created"] is False


def test_unimplemented_methods_raise_clear_not_implemented_error(monkeypatch):
    _configure(monkeypatch, SAP_DRY_RUN=True)
    from app.erp.sap.adapter import SAPAdapter

    adapter = SAPAdapter()

    with pytest.raises(NotImplementedError, match="get_customer"):
        adapter.get_customer("Some Customer")

    with pytest.raises(NotImplementedError, match="check_credit"):
        adapter.check_credit("C001", 100000.0, 5000.0)

    with pytest.raises(NotImplementedError, match="get_stock"):
        adapter.get_stock("P001")
