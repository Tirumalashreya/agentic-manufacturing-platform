# app/tests/test_production_completion_billing.py
"""Scrap-aware completion (P0 defect fix): POST /production-orders/:id/complete
now bills the order's real actual-good-units, never the planned quantity,
and honors an Idempotency-Key the same way 6 other real ERP-writing
operations in this codebase already do (app/tools/idempotency_tools.py's
IdempotencyKeys-sheet mechanism) — no new idempotency mechanism was built,
_deliver_and_bill just wasn't forwarding the key through before this.

Fully deterministic — no LLM, no network. mfg.get_production_order is
mocked (same convention as test_promise_recovery.py — the TS side isn't
live in this test run); billing_agent is mocked the same way
test_approvals_sales_order.py already mocks it. The ERP layer itself
(mock_erp.xlsx) is real, same integration-style convention as the rest of
this suite, protected by conftest.py's session-scoped backup/restore.
"""
import os
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("INTERNAL_SERVICE_TOKEN", "test-token-for-production-completion-tests")

from app.main import app  # noqa: E402
from app.schemas.billing import BillingDecision  # noqa: E402

client = TestClient(app)

AUTH_HEADERS = {"x-internal-token": os.environ["INTERNAL_SERVICE_TOKEN"]}


def _order(metadata: dict, quantity: float = 100) -> dict:
    return {
        "id": "test-po-1",
        "quantity": quantity,
        "status": "IN_PROGRESS",
        "enterpriseId": "test-enterprise",
        "metadata": metadata,
    }


def _billing_decision():
    return BillingDecision(payment_terms_days=30, notes="test")


@pytest.mark.asyncio
async def test_bills_the_actual_good_units_not_the_planned_quantity():
    metadata = {
        "salesOrderId": "SO-TEST-1", "customerId": "C018", "customerName": "Northgate Traders",
        "productId": "P011", "productName": "Wireless Mouse", "price": 800.0, "quantity": 100,
    }
    with patch("app.routers.production.mfg.get_production_order", AsyncMock(return_value=_order(metadata))), \
         patch("app.graph.billing_agent", return_value=_billing_decision()):
        response = client.post(
            "/production-orders/test-po-1/complete",
            headers=AUTH_HEADERS,
            json={"actualGoodUnits": 60},
        )

    assert response.status_code == 200
    body = response.json()
    assert body["billed"] is True
    # 60 units * 800.0 unit price = 48000.0 — proves 60 (actual) was
    # billed, not 100 (planned metadata.quantity).
    assert body["invoice_amount"] == 48000.0


@pytest.mark.asyncio
async def test_omitting_actualGoodUnits_falls_back_to_planned_quantity_unchanged():
    metadata = {
        "salesOrderId": "SO-TEST-2", "customerId": "C018", "customerName": "Northgate Traders",
        "productId": "P011", "productName": "Wireless Mouse", "price": 800.0, "quantity": 25,
    }
    with patch("app.routers.production.mfg.get_production_order", AsyncMock(return_value=_order(metadata, quantity=25))), \
         patch("app.graph.billing_agent", return_value=_billing_decision()):
        response = client.post("/production-orders/test-po-2/complete", headers=AUTH_HEADERS)

    assert response.status_code == 200
    body = response.json()
    assert body["invoice_amount"] == 25 * 800.0  # old behavior preserved for callers that send no body at all


@pytest.mark.asyncio
async def test_retrying_with_the_same_idempotency_key_does_not_create_a_second_delivery_or_invoice():
    metadata = {
        "salesOrderId": "SO-TEST-3", "customerId": "C018", "customerName": "Northgate Traders",
        "productId": "P011", "productName": "Wireless Mouse", "price": 800.0, "quantity": 100,
    }
    key = "test-po-3:BILLING:billing"
    with patch("app.routers.production.mfg.get_production_order", AsyncMock(return_value=_order(metadata))), \
         patch("app.graph.billing_agent", return_value=_billing_decision()):
        first = client.post(
            "/production-orders/test-po-3/complete",
            headers={**AUTH_HEADERS, "idempotency-key": key},
            json={"actualGoodUnits": 60},
        )
        retry = client.post(
            "/production-orders/test-po-3/complete",
            headers={**AUTH_HEADERS, "idempotency-key": key},
            json={"actualGoodUnits": 60},
        )

    assert first.status_code == 200
    assert retry.status_code == 200
    first_body, retry_body = first.json(), retry.json()
    # The real proof: identical delivery_id/invoice_id, not just identical
    # shape — a second real Excel row would have gotten a new id.
    assert retry_body["delivery_id"] == first_body["delivery_id"]
    assert retry_body["invoice_id"] == first_body["invoice_id"]


@pytest.mark.asyncio
async def test_without_an_idempotency_key_each_call_still_executes_for_real_unchanged_from_before():
    metadata = {
        "salesOrderId": "SO-TEST-4", "customerId": "C018", "customerName": "Northgate Traders",
        "productId": "P011", "productName": "Wireless Mouse", "price": 800.0, "quantity": 100,
    }
    with patch("app.routers.production.mfg.get_production_order", AsyncMock(return_value=_order(metadata))), \
         patch("app.graph.billing_agent", return_value=_billing_decision()):
        first = client.post("/production-orders/test-po-4/complete", headers=AUTH_HEADERS, json={"actualGoodUnits": 10})
        second = client.post("/production-orders/test-po-4/complete", headers=AUTH_HEADERS, json={"actualGoodUnits": 10})

    # No key means no dedup protection was requested — both really ran,
    # same as every other ERP-writing endpoint in this codebase without a key.
    assert first.json()["invoice_id"] != second.json()["invoice_id"]


@pytest.mark.asyncio
async def test_no_sales_order_id_on_metadata_is_still_the_same_honest_non_error_response():
    with patch("app.routers.production.mfg.get_production_order", AsyncMock(return_value=_order({}))):
        response = client.post("/production-orders/test-po-5/complete", headers=AUTH_HEADERS, json={"actualGoodUnits": 60})

    assert response.status_code == 200
    assert response.json() == {"billed": False, "reason": "no sales_order_id on this production order's metadata"}
