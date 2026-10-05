# app/tests/test_production_planning_agent.py
"""
The Production Planning Agent's real manufacturing-service calls
(app.integrations.manufacturing_services, imported into graph.py as `mfg`)
are mocked here, same as every other agent call in this test suite —
hitting the real TS services on every test run isn't practical. The real
integration itself is verified live (see the session's manual smoke test:
Orion Systems/15 Cable Management Kit -> PASS -> approve -> real RELEASED
order with real ScheduledOperation rows; Vertex Manufacturing/30 units ->
MATERIAL_SHORTAGE -> reject -> real cascading delete confirmed).
"""
from unittest.mock import AsyncMock, patch

import pytest

from app.agents.intent_agent import IntentResult
from app.graph import graph, _plan_production_via_manufacturing_services
from app.schemas.context import ContextResult
from app.schemas.fulfillment import FulfillmentDecision
from app.schemas.production_planning import ProductionPlanningDecision
from app.schemas.understanding import RequestedAction, RequestUnderstanding


def _intent(**overrides):
    base = dict(
        intent="create_order", customer="Orion Systems", product="Cable Management Kit",
        quantity=15, requested_deadline=None, needs_clarification=False, clarification_question=None,
    )
    base.update(overrides)
    return IntentResult(**base)


def _understanding(**overrides):
    plan = [
        RequestedAction(action="check_credit", depends_on=[]),
        RequestedAction(action="create_order", depends_on=["check_credit"]),
    ]
    base = dict(
        goal="test goal", constraints=[], requested_actions=[],
        mentions_product_or_service=True, mentions_financial_adjustment=False,
        is_supported=True, references=[], action_plan=plan, reasoning="test",
    )
    base.update(overrides)
    return RequestUnderstanding(**base)


def _context(**overrides):
    base = dict(
        customer_id="C024", customer_name="Orion Systems", customer_exists=True,
        customer_active=True, customer_credit_limit=100_000_000.0,
        product_id="P025", product_name="Cable Management Kit", product_valid=True, price=900.0,
        stock=[{"plant": "PLANT01", "stock_qty": 0}, {"plant": "PLANT02", "stock_qty": 0}],
        can_produce=True, product_configurable=False, lead_time_days=2,
    )
    base.update(overrides)
    return ContextResult(**base)


_BOM = {
    "id": "bom-1",
    "lines": [
        {"componentId": "comp-body", "quantityPer": 1, "component": {"family": "Cable Body"}},
        {"componentId": "comp-clip", "quantityPer": 2, "component": {"family": "Mounting Clip"}},
        {"componentId": "comp-fastener", "quantityPer": 4, "component": {"family": "Fastener"}},
    ],
}
_ROUTING = {
    "id": "routing-1",
    "operations": [
        {"id": "op-10", "opNumber": 10, "operation": "Cut/Prep Cable Body", "workCenter": {"code": "WC-ASSY"}},
        {"id": "op-20", "opNumber": 20, "operation": "Assemble", "workCenter": {"code": "WC-ASSY"}},
    ],
}


def _inventory(qty: int):
    return [{"qtyUnrestricted": qty}]


@pytest.mark.asyncio
async def test_plan_production_pass_when_materials_and_schedule_are_clean():
    with patch("app.graph.mfg.get_bom", new=AsyncMock(return_value=_BOM)), patch(
        "app.graph.mfg.get_routing", new=AsyncMock(return_value=_ROUTING)
    ), patch("app.graph.mfg.get_inventory", new=AsyncMock(return_value=_inventory(500))), patch(
        "app.graph.mfg.create_production_order", new=AsyncMock(return_value={"id": "po-1"})
    ), patch(
        "app.graph.mfg.trigger_what_if_scheduling",
        new=AsyncMock(return_value={
            "simulatedOperations": [
                {"productionOrderId": "po-1", "routingOperationId": "op-10", "machineId": "m-1",
                 "scheduledStart": "2026-09-10T09:00:00Z", "scheduledEnd": "2026-09-10T09:15:00Z"},
            ],
            "conflictsDetected": 0,
        }),
    ), patch("app.graph.mfg.get_machine", new=AsyncMock(return_value={"name": "M-01"})), patch(
        "app.graph.production_planning_agent",
        new=AsyncMock(return_value=ProductionPlanningDecision(status="PASS", explanation="All clear.")),
    ), patch("app.config.MANUFACTURING_PRODUCT_IDS", {"Cable Management Kit": "mfg-product-1"}):
        result = await _plan_production_via_manufacturing_services(
            product_id="P025", product_name="Cable Management Kit", quantity=15, required_date="2026-09-12",
        )

    assert result["verdict"] == "PASS"
    assert result["production_order_id"] == "po-1"
    assert len(result["materials"]) == 3
    assert all(m["shortage"] == 0 for m in result["materials"])
    assert len(result["simulated_operations"]) == 1
    assert result["simulated_operations"][0]["machine_name"] == "M-01"


@pytest.mark.asyncio
async def test_plan_production_forces_material_shortage_even_if_agent_says_pass():
    # Deterministic safety net (agreed with the user: "the service must
    # never hide the reason") — a real shortage always wins over whatever
    # the LLM classified it as.
    with patch("app.graph.mfg.get_bom", new=AsyncMock(return_value=_BOM)), patch(
        "app.graph.mfg.get_routing", new=AsyncMock(return_value=_ROUTING)
    ), patch("app.graph.mfg.get_inventory", new=AsyncMock(return_value=_inventory(1))), patch(
        "app.graph.mfg.create_production_order", new=AsyncMock(return_value={"id": "po-2"})
    ), patch(
        "app.graph.mfg.trigger_what_if_scheduling", new=AsyncMock(return_value={"simulatedOperations": [], "conflictsDetected": 0})
    ), patch("app.graph.mfg.get_machine", new=AsyncMock()), patch(
        "app.graph.production_planning_agent",
        new=AsyncMock(return_value=ProductionPlanningDecision(status="PASS", explanation="Looks fine to me.")),
    ), patch("app.config.MANUFACTURING_PRODUCT_IDS", {"Cable Management Kit": "mfg-product-1"}):
        result = await _plan_production_via_manufacturing_services(
            product_id="P025", product_name="Cable Management Kit", quantity=15, required_date=None,
        )

    assert result["verdict"] == "MATERIAL_SHORTAGE"
    assert any(m["shortage"] > 0 for m in result["materials"])


@pytest.mark.asyncio
async def test_plan_production_unplannable_when_product_not_mapped():
    with patch("app.config.MANUFACTURING_PRODUCT_IDS", {}):
        result = await _plan_production_via_manufacturing_services(
            product_id="P999", product_name="Unknown Widget", quantity=5, required_date=None,
        )

    assert result["verdict"] == "UNPLANNABLE"
    assert result["production_order_id"] is None
    assert "no manufacturing master data" in result["explanation"].lower() or "unknown widget" in result["explanation"].lower()


@pytest.mark.asyncio
async def test_composed_execution_mto_plans_production_before_approval():
    with patch("app.graph.intent_agent", return_value=_intent()), patch(
        "app.graph.request_understanding_agent", return_value=_understanding()
    ), patch("app.graph.context_agent", return_value=_context()), patch(
        "app.graph.process_agent", side_effect=AssertionError("process_agent should not be called")
    ), patch(
        "app.graph.fulfillment_agent",
        new=AsyncMock(return_value=FulfillmentDecision(strategy="MTO", reasoning="No stock; can produce.")),
    ), patch("app.graph.mfg.get_bom", new=AsyncMock(return_value=_BOM)), patch(
        "app.graph.mfg.get_routing", new=AsyncMock(return_value=_ROUTING)
    ), patch("app.graph.mfg.get_inventory", new=AsyncMock(return_value=_inventory(500))), patch(
        "app.graph.mfg.create_production_order", new=AsyncMock(return_value={"id": "po-3"})
    ), patch(
        "app.graph.mfg.trigger_what_if_scheduling", new=AsyncMock(return_value={"simulatedOperations": [], "conflictsDetected": 0})
    ), patch(
        "app.graph.production_planning_agent",
        new=AsyncMock(return_value=ProductionPlanningDecision(status="PASS", explanation="All clear.")),
    ), patch("app.config.MANUFACTURING_PRODUCT_IDS", {"Cable Management Kit": "mfg-product-1"}):
        result = await graph.ainvoke({"user_message": "anything"})

    assert result["status"] == "AWAITING_APPROVAL"
    # Nothing created yet — planning only.
    assert result.get("sales_order_id") is None
    preview = result["pending_approval"]["preview"]
    assert preview["fulfillment"]["strategy"] == "MTO"
    assert preview["production_plan"]["verdict"] == "PASS"
    assert preview["production_plan"]["production_order_id"] == "po-3"
    # Echoed through context so post-approval execution can replay it.
    assert result["pending_approval"]["context"]["production_plan"]["production_order_id"] == "po-3"


@pytest.mark.asyncio
async def test_composed_execution_mts_skips_production_planning_entirely():
    with patch("app.graph.intent_agent", return_value=_intent(product="Wireless Mouse", quantity=5)), patch(
        "app.graph.request_understanding_agent", return_value=_understanding()
    ), patch(
        "app.graph.context_agent",
        return_value=_context(
            product_id="P011", product_name="Wireless Mouse", price=800.0,
            stock=[{"plant": "PLANT01", "stock_qty": 200}],
        ),
    ), patch("app.graph.process_agent", side_effect=AssertionError("process_agent should not be called")), patch(
        "app.graph.fulfillment_agent",
        new=AsyncMock(return_value=FulfillmentDecision(strategy="MTS", reasoning="Plenty of stock.")),
    ), patch("app.graph.mfg.get_bom", side_effect=AssertionError("mfg should not be called for MTS")):
        result = await graph.ainvoke({"user_message": "anything"})

    preview = result["pending_approval"]["preview"]
    assert preview["fulfillment"]["strategy"] == "MTS"
    assert preview["production_plan"] is None
    assert preview["vendor_plan"] is None
