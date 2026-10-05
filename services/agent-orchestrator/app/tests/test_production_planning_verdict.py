# app/tests/test_production_planning_verdict.py
"""Phase 2 (agreed with the user): deterministic verdict classification for
_plan_production_via_manufacturing_services — WAITING_FOR_PRODUCTION_SLOT /
PLANNER_REVIEW / PLANNING_CONFIGURATION_ISSUE, and the guarantee that the
LLM's own decision.status can never override a deterministic fact.

Mocks app.graph.mfg.request_production_plan directly — the real, current
single call graph.py makes (see _plan_production_via_manufacturing_services's
own doc comment: BOM/routing/material/schedule all now come from one real
HTTP call to APS Platform). test_production_planning_agent.py's older tests
mock mfg.get_bom/get_routing/trigger_what_if_scheduling separately, which the
current implementation no longer calls at all — those tests were already
failing before this phase for that unrelated, pre-existing reason; this file
does not touch or fix that one, it just doesn't repeat its mistake.
"""
from unittest.mock import AsyncMock, patch

import pytest

from app.graph import _plan_production_via_manufacturing_services
from app.schemas.production_planning import ProductionPlanningDecision

_MATERIALS_OK = [
    {"component_id": "c1", "component_name": "Widget", "required": 10, "available": 100, "shortage": 0},
]


def _plan(**overrides) -> dict:
    base = dict(
        materials=_MATERIALS_OK,
        routing_operations=[{"operation_id": "op1", "operation": "Assemble", "op_number": 10, "work_center_code": "WC-A"}],
        simulated_operations=[{"operation": "Assemble", "machine_id": "m1", "machine_name": "M-01", "scheduled_start": "2026-10-01T00:00:00Z", "scheduled_end": "2026-10-01T01:00:00Z", "via_extended_horizon": False}],
        production_order_id="po-1",
        plant_id="plant-1",
        procurement_plan=[],
        quantity=10,
        has_shortage=False,
        scheduling_conflicts_detected=0,
        operations_not_placed=0,
        needed_extended_horizon=False,
    )
    base.update(overrides)
    return base


async def _run(plan: dict, decision_status: str = "PASS"):
    with patch("app.graph.mfg.request_production_plan", new=AsyncMock(return_value=plan)), patch(
        "app.graph.production_planning_agent",
        new=AsyncMock(return_value=ProductionPlanningDecision(status=decision_status, explanation="test explanation")),
    ), patch("app.config.MANUFACTURING_PRODUCT_IDS", {"Widget": "mfg-widget-1"}):
        return await _plan_production_via_manufacturing_services(
            product_id="P001", product_name="Widget", quantity=10, required_date=None,
        )


@pytest.mark.asyncio
async def test_normal_case_trusts_llm_pass():
    result = await _run(_plan(), decision_status="PASS")
    assert result["verdict"] == "PASS"


@pytest.mark.asyncio
async def test_normal_case_trusts_llm_warning():
    result = await _run(_plan(), decision_status="WARNING")
    assert result["verdict"] == "WARNING"


@pytest.mark.asyncio
async def test_material_shortage_forced_regardless_of_llm():
    # Regression: the pre-existing MATERIAL_SHORTAGE override, unchanged.
    result = await _run(_plan(has_shortage=True), decision_status="PASS")
    assert result["verdict"] == "MATERIAL_SHORTAGE"


@pytest.mark.asyncio
async def test_unplaced_operations_forces_planner_review_regardless_of_llm():
    # The actual bug this phase fixes: the LLM saying PASS must not survive
    # a real, deterministic "an operation couldn't be placed" fact.
    result = await _run(_plan(operations_not_placed=1), decision_status="PASS")
    assert result["verdict"] == "PLANNER_REVIEW"


@pytest.mark.asyncio
async def test_extended_horizon_needed_is_waiting_for_slot_not_a_failure():
    result = await _run(_plan(needed_extended_horizon=True), decision_status="WARNING")
    assert result["verdict"] == "WAITING_FOR_PRODUCTION_SLOT"


@pytest.mark.asyncio
async def test_material_shortage_wins_over_unplaced_and_extended_horizon():
    # Priority order: a real shortage is reported first, same as before
    # this phase — Phase 2 must not change what MATERIAL_SHORTAGE already
    # covers correctly.
    result = await _run(_plan(has_shortage=True, operations_not_placed=1, needed_extended_horizon=True))
    assert result["verdict"] == "MATERIAL_SHORTAGE"


@pytest.mark.asyncio
async def test_unplaced_wins_over_extended_horizon_flag():
    # If some ops needed extended horizon AND others never placed at all,
    # the honest answer is PLANNER_REVIEW (the plan is incomplete), not
    # WAITING_FOR_PRODUCTION_SLOT (which claims a complete, valid plan).
    result = await _run(_plan(operations_not_placed=1, needed_extended_horizon=True))
    assert result["verdict"] == "PLANNER_REVIEW"


@pytest.mark.asyncio
async def test_llm_cannot_reassert_unplannable_when_facts_show_no_problem():
    # The actual new defensive guard: deterministic facts say everything's
    # fine (no shortage, nothing unplaced, no extended horizon needed) —
    # even if the LLM hallucinates something outside PASS/WARNING, it must
    # not be trusted as the final word.
    result = await _run(_plan(), decision_status="MATERIAL_SHORTAGE")
    assert result["verdict"] == "WARNING"


@pytest.mark.asyncio
async def test_missing_manufacturing_mapping_is_planning_configuration_issue():
    with patch("app.config.MANUFACTURING_PRODUCT_IDS", {}), patch(
        "app.graph.mfg.request_production_plan", new=AsyncMock(side_effect=AssertionError("should not be called"))
    ):
        result = await _plan_production_via_manufacturing_services(
            product_id="P999", product_name="Unknown Widget", quantity=5, required_date=None,
        )
    assert result["verdict"] == "PLANNING_CONFIGURATION_ISSUE"
    assert result["production_order_id"] is None


@pytest.mark.asyncio
async def test_missing_bom_or_routing_passthrough_is_planning_configuration_issue():
    # apsAgent.ts's own early-return (no BOM and no routing at all) — the
    # TS side already returns this verdict directly; graph.py must pass it
    # through unchanged and never call the LLM for it.
    ts_result = {
        "verdict": "PLANNING_CONFIGURATION_ISSUE",
        "explanation": "No BOM or routing exists for Widget — production cannot be planned.",
        "materials": [], "routing_operations": [], "simulated_operations": [],
        "production_order_id": None, "plant_id": "plant-1", "procurement_plan": [],
    }
    with patch("app.graph.mfg.request_production_plan", new=AsyncMock(return_value=ts_result)), patch(
        "app.graph.production_planning_agent", new=AsyncMock(side_effect=AssertionError("should not be called"))
    ), patch("app.config.MANUFACTURING_PRODUCT_IDS", {"Widget": "mfg-widget-1"}):
        result = await _plan_production_via_manufacturing_services(
            product_id="P001", product_name="Widget", quantity=10, required_date=None,
        )
    assert result["verdict"] == "PLANNING_CONFIGURATION_ISSUE"
    assert result["production_order_id"] is None
