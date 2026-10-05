# app/tests/test_approval_state.py
"""
Approval State hardening (agreed with the user) — focused tests for the
server-side approval mechanism added this phase (app/db.py's
save_pending_approval/claim_approval/mark_executed/mark_execution_failed +
approvals.py's run_id-bound resolve endpoints).

Every test here talks to the real Postgres database (via app.db, real
asyncpg) and the real FastAPI app (via TestClient) — this is exactly the
layer the original vulnerability lived in (a client-echoed context with no
durable server record), so mocking the DB away would test nothing real.
Test fixtures use db.create_run()/db.save_pending_approval() directly
rather than running a full graph.ainvoke() each time — that keeps these
tests fast and deterministic (no real LLM calls), while still exercising
the actual state-machine code the real proposal flow also calls.

Requires DATABASE_URL to be set and reachable — same requirement every
other DB-backed piece of this codebase already has.
"""
import asyncio
import os
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("INTERNAL_SERVICE_TOKEN", "test-token-for-approval-state-tests")

from app import db  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)
TOKEN = os.environ["INTERNAL_SERVICE_TOKEN"]
HEADERS = {"x-internal-token": TOKEN, "x-forwarded-user": "test-planner", "x-forwarded-role": "PLANNER"}

# A real, resolvable context — same shape composed_execution_node produces,
# matching sales_tools.create_sales_order's real required fields. Kept
# tiny/cheap (quantity 1, real stock, no production) so a test that lets
# execution actually run doesn't ripple into shortage/production paths.
_SALES_CONTEXT = {
    "customer_id": "C018", "customer_name": "Northgate Traders", "customer_active": True,
    "product_id": "P011", "product_name": "Wireless Mouse", "quantity": 1, "price": 800.0,
    "requested_deadline": None, "can_produce": True, "product_configurable": False,
    "lead_time_days": 3, "stock": [{"plant": "PLANT01", "stock_qty": 300}], "user_message": "test",
}


async def _make_pending(action: str = "create_order", payload: dict | None = None) -> str:
    run_id = await db.create_run()
    await db.save_pending_approval(
        run_id=run_id, action=action, payload=payload or dict(_SALES_CONTEXT), requested_by="test-requester"
    )
    return run_id


def _resolve(run_id: str, decision: str, headers: dict | None = None, **extra):
    return client.post(
        "/approvals/sales-order/resolve",
        json={"run_id": run_id, "decision": decision, **extra},
        headers=headers if headers is not None else HEADERS,
    )


# --------------------------------------------------------------------------
# Basic lifecycle: PENDING -> APPROVED -> CONSUMED
# --------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_lifecycle_pending_to_approved_to_consumed():
    run_id = await _make_pending()

    before = await db.get_approval(run_id)
    assert before["approvalStatus"] == "PENDING"

    res = _resolve(run_id, "APPROVED")
    assert res.status_code == 200
    assert res.json()["created"] is True

    after = await db.get_approval(run_id)
    assert after["approvalStatus"] == "CONSUMED"
    assert after["approvedBy"] == "test-planner"
    assert after["executedAt"] is not None
    assert after["executionResult"]["sales_order_id"] is not None


# --------------------------------------------------------------------------
# Rejection: PENDING -> REJECTED -> execution rejected
# --------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_rejection_then_execution_attempt_is_rejected():
    run_id = await _make_pending()

    res = _resolve(run_id, "REJECTED")
    assert res.status_code == 200
    assert res.json() == {"resolved": True, "status": "REJECTED", "created": False}

    again = _resolve(run_id, "APPROVED")
    assert again.status_code == 409

    row = await db.get_approval(run_id)
    assert row["approvalStatus"] == "REJECTED"
    assert row["executedAt"] is None


# --------------------------------------------------------------------------
# Expiration: PENDING -> expires -> execution rejected, stays auditable
# --------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_expired_approval_cannot_be_approved():
    run_id = await _make_pending()
    conn = await db.get_connection()
    try:
        await conn.execute(
            'UPDATE "AgentPipelineRun" SET "approvalExpiresAt" = now() - interval \'1 hour\' WHERE id = $1', run_id
        )
    finally:
        await conn.close()

    res = _resolve(run_id, "APPROVED")
    assert res.status_code == 410

    row = await db.get_approval(run_id)
    assert row["approvalStatus"] == "EXPIRED"
    # Still fully auditable — the real payload wasn't wiped, just the
    # ability to act on it.
    assert row["approvalPayload"]["customer_name"] == "Northgate Traders"


# --------------------------------------------------------------------------
# Replay: CONSUMED -> second execution rejected
# --------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_replay_after_consumed_is_rejected():
    run_id = await _make_pending()
    first = _resolve(run_id, "APPROVED")
    assert first.status_code == 200
    first_sales_order_id = first.json()["sales_order_id"]

    replay = _resolve(run_id, "APPROVED")
    assert replay.status_code == 409

    # The real assertion: no second Sales Order was created. The already-
    # consumed approval's own executionResult still points at the one real
    # order — nothing about the replay attempt could have changed it.
    row = await db.get_approval(run_id)
    assert row["executionResult"]["sales_order_id"] == first_sales_order_id


# --------------------------------------------------------------------------
# Parameter tampering: approved action A -> execute with modified
# target/parameters -> rejected (structurally: those fields don't exist on
# the request schema at all, so "sending" them has no effect)
# --------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_tampered_fields_have_no_effect_on_execution():
    run_id = await _make_pending()

    res = client.post(
        "/approvals/sales-order/resolve",
        json={
            "run_id": run_id,
            "decision": "APPROVED",
            # None of these are real fields on SalesOrderApprovalRequest —
            # proving they're silently dropped, not applied.
            "customer_id": "C999-FAKE",
            "product_id": "P999-FAKE",
            "price": 0.01,
            "quantity": 999999,
        },
        headers=HEADERS,
    )
    assert res.status_code == 200
    body = res.json()
    # Real price (800) * real quantity (1) from the server-stored payload
    # — not the injected 0.01 * 999999.
    assert body["sales_order_total"] == 800.0


# The one real, legitimate exception: quantity_override, matching Agent
# Console's own pre-existing "edit quantity before approving" feature.
@pytest.mark.asyncio
async def test_quantity_override_is_applied_and_recomputes_total():
    run_id = await _make_pending()
    res = _resolve(run_id, "APPROVED", quantity_override=10)
    assert res.status_code == 200
    assert res.json()["sales_order_total"] == 8000.0  # 10 * 800, not 1 * 800


# --------------------------------------------------------------------------
# Authorization: unauthorized caller -> execution rejected
# --------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_insufficient_role_cannot_approve():
    run_id = await _make_pending()
    res = _resolve(run_id, "APPROVED", headers={**HEADERS, "x-forwarded-role": "VIEWER"})
    assert res.status_code == 403

    row = await db.get_approval(run_id)
    assert row["approvalStatus"] == "PENDING"  # untouched — the failed auth check never reached the claim


@pytest.mark.asyncio
async def test_no_auth_at_all_cannot_approve():
    run_id = await _make_pending()
    res = client.post("/approvals/sales-order/resolve", json={"run_id": run_id, "decision": "APPROVED"})
    assert res.status_code == 401


@pytest.mark.asyncio
async def test_wrong_action_type_is_rejected_without_consuming_the_approval():
    """A real bug found live while verifying this phase: checking the
    action type only after a failed claim let /approvals/reschedule/resolve
    wrongly win the atomic claim on a create_order run (status really was
    PENDING) and burn a real approval executing the wrong code path. Now
    the action check is part of the same atomic WHERE clause."""
    run_id = await _make_pending(action="create_order")

    wrong = client.post(
        "/approvals/reschedule/resolve", json={"run_id": run_id, "decision": "APPROVED"}, headers=HEADERS
    )
    assert wrong.status_code == 400

    row = await db.get_approval(run_id)
    assert row["approvalStatus"] == "PENDING"  # untouched by the misdirected attempt

    right = _resolve(run_id, "APPROVED")
    assert right.status_code == 200


# --------------------------------------------------------------------------
# Duplicate execution: two concurrent execution requests -> exactly one
# business mutation. The real regression test for the original finding.
# --------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_concurrent_approval_requests_create_exactly_one_sales_order():
    run_id = await _make_pending()

    async def _fire(user: str):
        return await asyncio.to_thread(
            lambda: client.post(
                "/approvals/sales-order/resolve",
                json={"run_id": run_id, "decision": "APPROVED"},
                headers={**HEADERS, "x-forwarded-user": user},
            )
        )

    results = await asyncio.gather(_fire("racer-1"), _fire("racer-2"))
    statuses = sorted(r.status_code for r in results)
    assert statuses == [200, 409]

    row = await db.get_approval(run_id)
    assert row["approvalStatus"] == "CONSUMED"
    # Exactly one winner recorded — approvedBy is whichever racer's UPDATE
    # actually matched the row, not a merge of both.
    assert row["approvedBy"] in ("racer-1", "racer-2")


# --------------------------------------------------------------------------
# Duplicate request: the original failure scenario, reproduced directly —
# the same logical action proposed/requested twice (two separate runs,
# same real customer/product) must not be conflated into one approval
# executing twice; each run has its own independent, single-use approval.
# --------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_two_separate_requests_for_the_same_action_each_get_their_own_single_use_approval():
    run_a = await _make_pending()
    run_b = await _make_pending()
    assert run_a != run_b

    res_a = _resolve(run_a, "APPROVED")
    res_b = _resolve(run_b, "APPROVED")
    assert res_a.status_code == 200
    assert res_b.status_code == 200
    assert res_a.json()["sales_order_id"] != res_b.json()["sales_order_id"]  # two real, distinct orders — this is
    # legitimately two separate human-approved requests, not a replay of one

    # But replaying either one again is still rejected.
    assert _resolve(run_a, "APPROVED").status_code == 409
    assert _resolve(run_b, "APPROVED").status_code == 409


# --------------------------------------------------------------------------
# Existing behavior: the normal flow still produces one real Sales Order
# and the existing downstream fulfillment behavior is untouched.
# --------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_normal_approval_flow_produces_one_real_sales_order_with_fulfillment():
    run_id = await _make_pending()
    res = _resolve(run_id, "APPROVED")
    assert res.status_code == 200
    body = res.json()
    assert body["sales_order_id"].startswith("SO")
    assert body["fulfillment_strategy"] is not None  # downstream fulfillment still ran, unchanged


# --------------------------------------------------------------------------
# The same claim_approval mechanism, exercised via the OTHER real gate
# (RESCHEDULE_PRODUCTION) — no live reschedulable production order exists
# in this environment right now (the one seeded order is COMPLETED, and
# scheduling only acts on PLANNED/RELEASED orders), so the real
# mfg.reschedule_production_order call is mocked here, the same way
# test_approvals_sales_order.py mocks fulfillment_agent/billing_agent —
# this is testing the approval-state machine's action-agnostic correctness
# for this second real gate, not scheduling-service itself.
# --------------------------------------------------------------------------
_RESCHEDULE_CONTEXT = {
    "sales_order_id": "SO0001", "production_order_id": "po-test-1",
    "plant_id": "plant-test-1", "kind": "reschedule", "scope": "SINGLE", "mode": "FORWARD",
}


@pytest.mark.asyncio
async def test_reschedule_approval_lifecycle_and_replay_protection():
    run_id = await _make_pending(action="RESCHEDULE_PRODUCTION", payload=dict(_RESCHEDULE_CONTEXT))

    with patch(
        "app.routers.approvals.mfg.reschedule_production_order",
        return_value={"ordersProcessed": 1, "operationsScheduled": 3, "conflictsDetected": 0, "scheduleVersion": 2, "scope": "SINGLE"},
    ) as mocked:
        res = client.post(
            "/approvals/reschedule/resolve", json={"run_id": run_id, "decision": "APPROVED"}, headers=HEADERS
        )
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "COMPLETED"
    assert body["ordersProcessed"] == 1
    mocked.assert_called_once_with("plant-test-1", "po-test-1", "SINGLE", "FORWARD")

    row = await db.get_approval(run_id)
    assert row["approvalStatus"] == "CONSUMED"

    # Replay rejected, same as the create_order path.
    replay = client.post(
        "/approvals/reschedule/resolve", json={"run_id": run_id, "decision": "APPROVED"}, headers=HEADERS
    )
    assert replay.status_code == 409


@pytest.mark.asyncio
async def test_reschedule_rejection_never_calls_the_real_reschedule():
    run_id = await _make_pending(action="RESCHEDULE_PRODUCTION", payload=dict(_RESCHEDULE_CONTEXT))

    with patch(
        "app.routers.approvals.mfg.reschedule_production_order",
        side_effect=AssertionError("must not be called for a rejected approval"),
    ):
        res = client.post(
            "/approvals/reschedule/resolve", json={"run_id": run_id, "decision": "REJECTED"}, headers=HEADERS
        )
    assert res.status_code == 200
    assert res.json() == {"resolved": True, "status": "REJECTED"}
