# app/tests/test_order_domain_dual_write.py
"""Order-to-production Phase 1: the dual-write that creates real, connected
Postgres SalesOrder/OrderLine/FulfillmentPlan/FulfillmentLine rows
alongside the existing mock-ERP SalesOrders-sheet write, plus the FK-patch
that links a FulfillmentLine's production leg to the real ProductionOrder
once it exists.

Fully mocked (app.integrations.order_domain never makes a real HTTP call
here) — matches this repo's established fast/deterministic Python test
convention. Live, end-to-end verification against the real running stack
(real Postgres rows, real ProductionOrder.salesOrderId FK) was done
separately and is reported alongside this phase's summary, not repeated
here.
"""
import os
from contextlib import contextmanager
from unittest.mock import AsyncMock, patch

import pytest

os.environ.setdefault("INTERNAL_SERVICE_TOKEN", "test-token-for-dual-write-tests")

from app.graph import (  # noqa: E402
    _dual_write_order_and_fulfillment,
    _execute_production_plan,
    _patch_stock_execution,
    _patch_vendor_execution,
    run_post_approval_fulfillment,
)


def _state(**overrides):
    base = dict(
        sales_order_id="SO-9001",
        customer_name="Nova Electronics",
        product_id="P025",
        product_name="Cable Management Kit",
        quantity=250,
        price=900.0,
        lead_time_days=2,
        fulfillment_strategy="MTS",
        fulfillment_reasoning="test reasoning",
        fulfillment_from_stock=250,
        fulfillment_to_produce=0,
        response="",
    )
    base.update(overrides)
    return base


@contextmanager
def _mock_order_domain():
    with patch("app.graph.order_domain.find_or_create_customer", AsyncMock(return_value="cust-real-id")), \
         patch("app.graph.order_domain.create_sales_order_record", AsyncMock(return_value="so-real-id")), \
         patch("app.graph.order_domain.create_order_line_and_fulfillment", AsyncMock(return_value={
             "orderLineId": "ol-1", "fulfillmentPlanId": "fp-1", "fulfillmentLines": [],
         })) as create_line, \
         patch("app.graph.order_domain.patch_fulfillment_line", AsyncMock(return_value=None)) as patch_line:
        yield {"create_order_line_and_fulfillment": create_line, "patch_fulfillment_line": patch_line}


@pytest.mark.asyncio
async def test_mts_creates_one_stock_fulfillment_line():
    state = _state(fulfillment_strategy="MTS", fulfillment_from_stock=250, fulfillment_to_produce=0)
    with _mock_order_domain() as mocks:
        mocks["create_order_line_and_fulfillment"].return_value = {
            "orderLineId": "ol-1", "fulfillmentPlanId": "fp-1",
            "fulfillmentLines": [{"id": "fl-stock", "sourceType": "STOCK"}],
        }
        result = await _dual_write_order_and_fulfillment(state, context={})

    assert result["real_sales_order_id"] == "so-real-id"
    assert result["fulfillment_line_ids"] == {"STOCK": "fl-stock"}
    _, kwargs = mocks["create_order_line_and_fulfillment"].call_args
    assert kwargs["lines"] == [{"sourceType": "STOCK", "quantity": 250}]


@pytest.mark.asyncio
async def test_mto_creates_one_production_fulfillment_line():
    state = _state(fulfillment_strategy="MTO", fulfillment_from_stock=0, fulfillment_to_produce=250)
    with _mock_order_domain() as mocks:
        mocks["create_order_line_and_fulfillment"].return_value = {
            "orderLineId": "ol-1", "fulfillmentPlanId": "fp-1",
            "fulfillmentLines": [{"id": "fl-prod", "sourceType": "PRODUCTION"}],
        }
        result = await _dual_write_order_and_fulfillment(state, context={})

    assert result["fulfillment_line_ids"] == {"PRODUCTION": "fl-prod"}
    _, kwargs = mocks["create_order_line_and_fulfillment"].call_args
    assert kwargs["lines"] == [{"sourceType": "PRODUCTION", "quantity": 250}]


@pytest.mark.asyncio
async def test_hybrid_creates_two_fulfillment_lines_summing_to_order_quantity():
    state = _state(fulfillment_strategy="HYBRID", fulfillment_from_stock=165, fulfillment_to_produce=85)
    with _mock_order_domain() as mocks:
        mocks["create_order_line_and_fulfillment"].return_value = {
            "orderLineId": "ol-1", "fulfillmentPlanId": "fp-1",
            "fulfillmentLines": [
                {"id": "fl-stock", "sourceType": "STOCK"},
                {"id": "fl-prod", "sourceType": "PRODUCTION"},
            ],
        }
        result = await _dual_write_order_and_fulfillment(state, context={})

    assert result["fulfillment_line_ids"] == {"STOCK": "fl-stock", "PRODUCTION": "fl-prod"}
    _, kwargs = mocks["create_order_line_and_fulfillment"].call_args
    lines = kwargs["lines"]
    assert lines == [
        {"sourceType": "STOCK", "quantity": 165},
        {"sourceType": "PRODUCTION", "quantity": 85},
    ]
    assert sum(l["quantity"] for l in lines) == 250


@pytest.mark.asyncio
async def test_third_party_creates_one_drop_ship_fulfillment_line_with_vendor_info():
    # Fulfillment architecture hardening: THIRD_PARTY (ships straight to the
    # customer) is real DROP_SHIP, not the old generic VENDOR sourceType.
    state = _state(fulfillment_strategy="THIRD_PARTY", fulfillment_from_stock=0, fulfillment_to_produce=40)
    context = {"vendor_plan": {"vendor_id": "PV004", "vendor_name": "Nexus Hardware Supply", "drop_ship": True}}
    with _mock_order_domain() as mocks:
        mocks["create_order_line_and_fulfillment"].return_value = {
            "orderLineId": "ol-1", "fulfillmentPlanId": "fp-1",
            "fulfillmentLines": [{"id": "fl-vendor", "sourceType": "DROP_SHIP"}],
        }
        result = await _dual_write_order_and_fulfillment(state, context)

    assert result["fulfillment_line_ids"] == {"DROP_SHIP": "fl-vendor"}
    _, kwargs = mocks["create_order_line_and_fulfillment"].call_args
    assert kwargs["lines"] == [{
        "sourceType": "DROP_SHIP", "quantity": 40,
        "vendorId": "PV004", "vendorName": "Nexus Hardware Supply",
    }]


@pytest.mark.asyncio
async def test_trading_creates_a_buy_fulfillment_line_not_a_production_one():
    # Fulfillment architecture hardening: TRADING (vendor ships to our
    # warehouse first, not direct to customer) is real BUY — a real bug
    # this closed: it used to fall into the generic `elif` branch and get
    # mislabeled as a PRODUCTION leg, since TRADING never touches
    # production at all. See _plan_vendor_sourcing's strategy_label:
    # "THIRD_PARTY" if drop_ship else "TRADING".
    state = _state(fulfillment_strategy="TRADING", fulfillment_from_stock=0, fulfillment_to_produce=30)
    context = {"vendor_plan": {"vendor_id": "PV001", "vendor_name": "Metro Webcam Distributors", "drop_ship": False}}
    with _mock_order_domain() as mocks:
        mocks["create_order_line_and_fulfillment"].return_value = {
            "orderLineId": "ol-1", "fulfillmentPlanId": "fp-1",
            "fulfillmentLines": [{"id": "fl-vendor", "sourceType": "BUY"}],
        }
        result = await _dual_write_order_and_fulfillment(state, context)

    assert result["fulfillment_line_ids"] == {"BUY": "fl-vendor"}
    _, kwargs = mocks["create_order_line_and_fulfillment"].call_args
    assert kwargs["lines"] == [{
        "sourceType": "BUY", "quantity": 30,
        "vendorId": "PV001", "vendorName": "Metro Webcam Distributors",
    }]
    assert kwargs["strategy"] == "TRADING"


@pytest.mark.asyncio
async def test_prefer_vendor_path_reaches_the_canonical_domain_model():
    # Remediation regression: the prefer_vendor early-return in
    # run_post_approval_fulfillment used to `return state` before the
    # dual-write ever ran — a real Trading Order was created (mock-ERP
    # side) with no corresponding SalesOrder/OrderLine/FulfillmentPlan/
    # FulfillmentLine. This proves that gap is closed: the human-override
    # "source from vendor instead" path now reaches the same canonical
    # domain write every other real fulfillment path reaches.
    context = {
        "customer_id": "C025", "customer_name": "Nexus Hardware Supply Customer",
        "product_id": "P025", "product_name": "Cable Management Kit",
        "quantity": 10, "price": 900.0, "can_produce": True, "product_configurable": False,
        "lead_time_days": 5, "stock": [{"plant": "PLANT01", "stock_qty": 0}],
        "vendor_plan": {
            "vendors_available": True, "vendor_id": "PV004", "vendor_name": "Nexus Hardware Supply",
            "unit_cost": 700, "lead_time_days": 5, "drop_ship": True,
            "strategy_label": "THIRD_PARTY", "reasoning": "cheapest/fastest option",
        },
        "production_plan": None,
    }
    with patch(
        "app.graph.create_trading_order",
        return_value={"created": True, "trading_order_id": "TRD-1", "expected_arrival": "2026-10-05"},
    ), _mock_order_domain() as mocks:
        mocks["create_order_line_and_fulfillment"].return_value = {
            "orderLineId": "ol-1", "fulfillmentPlanId": "fp-1",
            "fulfillmentLines": [{"id": "fl-vendor", "sourceType": "DROP_SHIP"}],
        }
        result = await run_post_approval_fulfillment(context, sales_order_id="SO-9002", prefer_vendor=True)

    assert result["fulfillment_strategy"] == "THIRD_PARTY"
    assert result["real_sales_order_id"] == "so-real-id"
    assert result["fulfillment_line_ids"] == {"DROP_SHIP": "fl-vendor"}
    mocks["create_order_line_and_fulfillment"].assert_awaited_once()
    _, kwargs = mocks["create_order_line_and_fulfillment"].call_args
    assert kwargs["lines"] == [{
        "sourceType": "DROP_SHIP", "quantity": 10,
        "vendorId": "PV004", "vendorName": "Nexus Hardware Supply",
    }]
    # Fulfillment architecture hardening: the execution lifecycle patch
    # also ran — two real transitions (PENDING -> EXECUTION_CREATED ->
    # FULFILLED), with the real Trading Order id recorded as the execution
    # reference on the second one.
    assert mocks["patch_fulfillment_line"].await_args_list == [
        (("fl-vendor",), {"status": "EXECUTION_CREATED"}),
        (("fl-vendor",), {"execution_reference": "TRD-1", "status": "FULFILLED", "promised_date": "2026-10-05"}),
    ]


@pytest.mark.asyncio
async def test_prefer_vendor_failure_does_not_reach_the_dual_write():
    # The other half of the same fix: a FAILED trading order must not
    # produce a phantom domain record either.
    context = {
        "customer_id": "C025", "customer_name": "Test Customer",
        "product_id": "P025", "product_name": "Cable Management Kit",
        "quantity": 10, "price": 900.0, "can_produce": True, "product_configurable": False,
        "lead_time_days": 5, "stock": [{"plant": "PLANT01", "stock_qty": 0}],
        "vendor_plan": {
            "vendors_available": True, "vendor_id": "PV004", "vendor_name": "Nexus Hardware Supply",
            "unit_cost": 700, "lead_time_days": 5, "drop_ship": True,
            "strategy_label": "THIRD_PARTY", "reasoning": "test",
        },
        "production_plan": None,
    }
    with patch(
        "app.graph.create_trading_order",
        return_value={"created": False, "reason": "vendor rejected the order"},
    ), _mock_order_domain() as mocks:
        result = await run_post_approval_fulfillment(context, sales_order_id="SO-9003", prefer_vendor=True)

    assert result["status"] == "FULFILLMENT_FAILED"
    mocks["create_order_line_and_fulfillment"].assert_not_awaited()


@pytest.mark.asyncio
async def test_dual_write_failure_is_best_effort_and_never_raises():
    state = _state()
    with patch("app.graph.order_domain.find_or_create_customer", AsyncMock(side_effect=RuntimeError("order-service down"))):
        result = await _dual_write_order_and_fulfillment(state, context={})

    assert result == {"real_sales_order_id": None, "fulfillment_line_ids": {}}


@pytest.mark.asyncio
async def test_production_commit_patches_the_production_fulfillment_line():
    # A real, minimal production_plan shape — matches what
    # _plan_production_via_manufacturing_services/composed_execution_node
    # actually hands run_post_approval_fulfillment via context, per
    # graph.py's own _execute_production_plan.
    production_plan = {
        "verdict": "PASS",
        "production_order_id": "po-real-1",
        "plant_id": "plant-1",
        "quantity": 85,
        "procurement_plan": [],
    }
    state = _state(
        fulfillment_strategy="MTO", fulfillment_from_stock=0, fulfillment_to_produce=85,
        real_sales_order_id="so-real-id", fulfillment_line_ids={"PRODUCTION": "fl-prod"},
    )
    with patch(
        "app.graph._commit_production_plan",
        AsyncMock(return_value={"production_order_id": "po-real-1", "status": "RELEASED", "scheduled_operations": []}),
    ), patch("app.graph.order_domain.patch_fulfillment_line", AsyncMock(return_value=None)) as patch_line, patch(
        "app.graph.mfg.create_purchase_order", AsyncMock()
    ):
        result = await _execute_production_plan(state, production_plan)

    assert result["production_order_id"] == "po-real-1"
    # EXECUTION_CREATED, not FULFILLED — the real ProductionOrder now
    # exists and is linked, but production itself is still ahead of us.
    # promised_date is None here — no scheduled operations exist yet in
    # this particular mocked commit (see the next test for the real case).
    patch_line.assert_awaited_once_with(
        "fl-prod", production_order_id="po-real-1", status="EXECUTION_CREATED", promised_date=None
    )


@pytest.mark.asyncio
async def test_production_commit_promised_date_is_the_latest_real_scheduled_end():
    # Order Orchestration (Phase 2): the real promised date is the LATEST
    # scheduledEnd across every real operation APS just placed — never
    # invented, computed from the same commit result already used to
    # build the human-readable response text.
    production_plan = {
        "verdict": "PASS", "production_order_id": "po-real-1", "plant_id": "plant-1",
        "quantity": 85, "procurement_plan": [],
    }
    state = _state(
        fulfillment_strategy="MTO", fulfillment_from_stock=0, fulfillment_to_produce=85,
        real_sales_order_id="so-real-id", fulfillment_line_ids={"PRODUCTION": "fl-prod"},
    )
    with patch(
        "app.graph._commit_production_plan",
        AsyncMock(return_value={
            "production_order_id": "po-real-1", "status": "RELEASED",
            "scheduled_operations": [
                {"routingOperationId": "op-1", "machineId": "M-01", "scheduledEnd": "2026-10-02T10:00:00.000Z"},
                {"routingOperationId": "op-2", "machineId": "M-02", "scheduledEnd": "2026-10-03T14:00:00.000Z"},
                {"routingOperationId": "op-3", "machineId": "M-01", "scheduledEnd": "2026-10-02T22:00:00.000Z"},
            ],
        }),
    ), patch("app.graph.order_domain.patch_fulfillment_line", AsyncMock(return_value=None)) as patch_line, patch(
        "app.graph.mfg.create_purchase_order", AsyncMock()
    ):
        await _execute_production_plan(state, production_plan)

    patch_line.assert_awaited_once_with(
        "fl-prod", production_order_id="po-real-1", status="EXECUTION_CREATED",
        promised_date="2026-10-03T14:00:00.000Z",  # the latest of the three, not the first or last-listed
    )


@pytest.mark.asyncio
async def test_production_plan_failure_marks_the_production_line_failed():
    state = _state(
        fulfillment_strategy="MTO", fulfillment_from_stock=0, fulfillment_to_produce=85,
        real_sales_order_id="so-real-id", fulfillment_line_ids={"PRODUCTION": "fl-prod"},
    )
    with patch("app.graph.order_domain.patch_fulfillment_line", AsyncMock(return_value=None)) as patch_line:
        result = await _execute_production_plan(state, {"verdict": "PLANNER_REVIEW", "production_order_id": "po-1", "explanation": "no slot"})

    assert result["status"] == "FULFILLMENT_FAILED"
    patch_line.assert_awaited_once_with("fl-prod", status="FAILED")


# Fulfillment architecture hardening: _patch_stock_execution/
# _patch_vendor_execution are the real orchestration boundary between "what
# happened" (a branch's own return dict) and "the canonical fulfillment
# record" — tested directly rather than only indirectly through the larger
# node functions above.
@pytest.mark.asyncio
async def test_patch_stock_execution_on_success_sets_reference_and_fulfilled():
    # Two real transitions, not one: PENDING -> ALLOCATED -> FULFILLED —
    # order-service's own transition table (FULFILLMENT_LINE_TRANSITIONS)
    # has no direct PENDING -> FULFILLED edge, so this proves the caller
    # respects the same state machine it enforces. Order Orchestration
    # (Phase 2): the real confirmed delivery date is forwarded as
    # promised_date, never invented.
    state = _state(fulfillment_line_ids={"STOCK": "fl-stock"})
    with patch("app.graph.order_domain.patch_fulfillment_line", AsyncMock(return_value=None)) as patch_line:
        await _patch_stock_execution(state, {
            "reservation_id": "RSV-1", "status": "FULFILLED", "confirmed_delivery_date": "2026-10-02",
        })
    assert patch_line.await_args_list == [
        (("fl-stock",), {"status": "ALLOCATED"}),
        (("fl-stock",), {"execution_reference": "RSV-1", "status": "FULFILLED", "promised_date": "2026-10-02"}),
    ]


@pytest.mark.asyncio
async def test_patch_stock_execution_on_failure_marks_failed():
    state = _state(fulfillment_line_ids={"STOCK": "fl-stock"})
    with patch("app.graph.order_domain.patch_fulfillment_line", AsyncMock(return_value=None)) as patch_line:
        await _patch_stock_execution(state, {"status": "FULFILLMENT_FAILED"})
    patch_line.assert_awaited_once_with("fl-stock", status="FAILED")


@pytest.mark.asyncio
async def test_patch_stock_execution_is_a_noop_when_there_is_no_stock_line():
    state = _state(fulfillment_line_ids={"PRODUCTION": "fl-prod"})  # no STOCK key — e.g. pure MTO
    with patch("app.graph.order_domain.patch_fulfillment_line", AsyncMock(return_value=None)) as patch_line:
        await _patch_stock_execution(state, {"reservation_id": "RSV-1", "status": "FULFILLED"})
    patch_line.assert_not_awaited()


@pytest.mark.asyncio
async def test_patch_vendor_execution_finds_either_buy_or_drop_ship_key():
    # Order Orchestration (Phase 2): the real vendor-quoted arrival date is
    # forwarded as promised_date, never invented.
    state = _state(fulfillment_line_ids={"BUY": "fl-buy"})
    with patch("app.graph.order_domain.patch_fulfillment_line", AsyncMock(return_value=None)) as patch_line:
        await _patch_vendor_execution(state, {"trading_order_id": "TO-1", "expected_arrival": "2026-10-05"})
    assert patch_line.await_args_list == [
        (("fl-buy",), {"status": "EXECUTION_CREATED"}),
        (("fl-buy",), {"execution_reference": "TO-1", "status": "FULFILLED", "promised_date": "2026-10-05"}),
    ]
