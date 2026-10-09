# app/tests/test_approvals_sales_order.py
"""Fully deterministic — no LLM, no network. Uses FastAPI's TestClient
against the real router + real ERP tools (no mocking of the ERP layer,
same integration-style convention as the rest of this test suite).

An APPROVED order now continues into run_post_approval_fulfillment (see
graph.py) — the same fulfillment_agent/billing_agent calls the normal
DIRECT_SALES path makes, so those two get mocked here the same way
test_composed_execution.py mocks intent/understanding/context, to keep
this suite LLM-free.

Approval State hardening (agreed with the user): these tests used to POST
a raw `context` dict straight to /approvals/sales-order/resolve — the
exact client-echoed-context pattern this phase closed. Each test now
creates a real, server-owned pending approval first (via db.create_run +
db.save_pending_approval, the same real functions the live proposal flow
calls) and resolves it by run_id, matching the real contract. See
test_approval_state.py for the approval-state machine's own dedicated
tests (lifecycle/replay/expiry/tampering/concurrency); this file stays
focused on the business-logic scenarios it always covered — fulfillment
failure handling, prefer_vendor — just against the new contract.
"""
import os
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("INTERNAL_SERVICE_TOKEN", "test-token-for-approvals-tests")

from app import db  # noqa: E402  (must import after setting the token above)
from app.approval_proposal import compute_proposal_hash  # noqa: E402
from app.integrations.manufacturing_services import AGENT_ORCHESTRATOR_ENTERPRISE_ID  # noqa: E402
from app.main import app  # noqa: E402
from app.schemas.billing import BillingDecision
from app.schemas.fulfillment import FulfillmentDecision

client = TestClient(app)

AUTH_HEADERS = {
    "x-internal-token": os.environ["INTERNAL_SERVICE_TOKEN"],
    "x-forwarded-user": "test-planner",
    "x-forwarded-role": "PLANNER",
}


def _context(**overrides):
    base = dict(
        customer_id="C018", customer_name="Northgate Traders", customer_active=True,
        product_id="P011", product_name="Wireless Mouse", quantity=3, price=800.0,
        requested_deadline=None,
        can_produce=True, product_configurable=False, lead_time_days=3,
        stock=[{"plant": "PLANT01", "stock_qty": 300}], user_message="test",
    )
    base.update(overrides)
    return base


async def _pending(context: dict) -> str:
    run_id = await db.create_run()
    await db.save_pending_approval(
        run_id=run_id,
        action="create_order",
        payload=context,
        requested_by="test-requester",
        enterprise_id=AGENT_ORCHESTRATOR_ENTERPRISE_ID,
        proposal_hash=compute_proposal_hash("create_order", context),
    )
    return run_id


def _resolve(run_id: str, decision: str, **extra):
    return client.post(
        "/approvals/sales-order/resolve", json={"run_id": run_id, "decision": decision, **extra}, headers=AUTH_HEADERS
    )


@pytest.mark.asyncio
async def test_approve_creates_a_real_sales_order():
    run_id = await _pending(_context())
    with patch(
        "app.graph.fulfillment_agent",
        return_value=FulfillmentDecision(strategy="MTS", reasoning="test"),
    ), patch(
        "app.graph.billing_agent",
        return_value=BillingDecision(payment_terms_days=30, notes="test"),
    ):
        response = _resolve(run_id, "APPROVED")

    assert response.status_code == 200
    body = response.json()
    assert body["created"] is True
    assert body["sales_order_id"] is not None
    assert body["sales_order_status"] == "CONFIRMED"
    assert body["sales_order_total"] == 2400.0
    # The new part: fulfillment actually ran, all the way to billing.
    assert body["fulfillment_strategy"] == "MTS"
    assert body["invoice_id"] is not None
    assert body["delivery_id"] is not None


@pytest.mark.asyncio
async def test_approve_reports_fulfillment_failure_without_undoing_the_order():
    # A gap surfaced honestly, not raised as a 500: the order is real and
    # already created by the time fulfillment runs, so a broken
    # fulfillment step must not look like the whole approval failed.
    run_id = await _pending(_context())
    with patch("app.graph.fulfillment_agent", side_effect=RuntimeError("groq down")):
        response = _resolve(run_id, "APPROVED")

    assert response.status_code == 200
    body = response.json()
    assert body["created"] is True
    assert body["sales_order_id"] is not None
    assert body["fulfillment_status"] == "FULFILLMENT_FAILED"


@pytest.mark.asyncio
async def test_prefer_vendor_bypasses_the_fulfillment_agent_entirely():
    # The human override (agreed with the user): only valid for the true
    # zero-stock case — Cable Management Kit (P025) has zero stock and a
    # real vendor on file (Nexus Hardware Supply) in the seed data. Using
    # a side_effect that raises proves this is a genuine deterministic
    # bypass, not "ask the LLM to consider preferring a vendor."
    context = _context(
        product_id="P025", product_name="Cable Management Kit", quantity=10, price=900.0,
        stock=[{"plant": "PLANT01", "stock_qty": 0}, {"plant": "PLANT02", "stock_qty": 0}],
    )
    run_id = await _pending(context)
    with patch("app.graph.fulfillment_agent", side_effect=AssertionError("fulfillment_agent should not be called")):
        response = _resolve(run_id, "APPROVED", prefer_vendor=True)

    assert response.status_code == 200
    body = response.json()
    assert body["created"] is True
    assert body["fulfillment_strategy"] == "THIRD_PARTY"
    assert "human choice" in body["fulfillment_reasoning"].lower()
    assert body["fulfillment_status"] == "SOURCING"


@pytest.mark.asyncio
async def test_prefer_vendor_falls_through_to_normal_decision_when_no_vendor_exists():
    # Defensive fallback: the frontend only ever offers this choice when
    # the approval preview already said a vendor is real — but if
    # prefer_vendor arrives true for a product with none, this must not
    # error, it should just fall through to the Fulfillment Agent's own
    # normal (mocked here) decision.
    context = _context(
        product_id="P001", product_name="Laptop - Standard", quantity=5, price=50000.0,
        stock=[{"plant": "PLANT01", "stock_qty": 0}, {"plant": "PLANT02", "stock_qty": 0}],
    )
    run_id = await _pending(context)
    with patch(
        "app.graph.fulfillment_agent",
        return_value=FulfillmentDecision(strategy="MTO", reasoning="test"),
    ):
        response = _resolve(run_id, "APPROVED", prefer_vendor=True)

    assert response.status_code == 200
    body = response.json()
    assert body["fulfillment_strategy"] == "MTO"


@pytest.mark.asyncio
async def test_reject_creates_nothing():
    run_id = await _pending(_context())
    response = _resolve(run_id, "REJECTED")

    assert response.status_code == 200
    body = response.json()
    assert body["created"] is False
    assert body["status"] == "REJECTED"


@pytest.mark.asyncio
async def test_reject_with_no_stale_production_order_has_no_cleanup_warning():
    # No production_plan at all (the MTS/plain case) — nothing to clean
    # up, so no cleanup_warning key should appear (no regression on the
    # ordinary reject path).
    run_id = await _pending(_context())
    response = _resolve(run_id, "REJECTED")

    assert response.status_code == 200
    assert "cleanup_warning" not in response.json()


@pytest.mark.asyncio
async def test_reject_cleanup_failure_is_reported_not_swallowed():
    # Stage 01 (Fail Loud, Fail Closed) — ARCHITECTURE_BASELINE.md §5/§11:
    # this is the bare `except Exception: pass` previously at this
    # endpoint's REJECTED branch. A failed cleanup of the stale, orphaned
    # ProductionOrder must be logged and surfaced — never silently
    # dropped — while the rejection itself (already real and committed)
    # must not be reported as having failed.
    context = _context(production_plan={"production_order_id": "po-stale-reject-1"})
    run_id = await _pending(context)
    with patch(
        "app.routers.approvals.mfg.delete_production_order",
        side_effect=RuntimeError("order-service unreachable"),
    ) as delete_mock:
        response = _resolve(run_id, "REJECTED")

    assert response.status_code == 200
    body = response.json()
    # The rejection itself is NOT reported as failed.
    assert body["status"] == "REJECTED"
    assert body["created"] is False
    # The cleanup failure is visible, not hidden.
    assert "po-stale-reject-1" in body["cleanup_warning"]
    assert "order-service unreachable" in body["cleanup_warning"]
    delete_mock.assert_called_once_with("po-stale-reject-1")


@pytest.mark.asyncio
async def test_invalid_decision_is_rejected():
    run_id = await _pending(_context())
    response = _resolve(run_id, "MAYBE")

    assert response.status_code == 400


@pytest.mark.asyncio
async def test_approve_with_invalid_context_returns_400_not_a_crash():
    run_id = await _pending(_context(customer_id=None))
    response = _resolve(run_id, "APPROVED")

    assert response.status_code == 400


@pytest.mark.asyncio
async def test_unknown_run_id_returns_404():
    response = _resolve("run-id-that-does-not-exist", "APPROVED")

    assert response.status_code == 404
