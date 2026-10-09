# app/tests/test_promise_reasoning.py
"""Phase 10 (Agentic Order Promise & Scenario Reasoning) — tests for
promise_reasoning_node (app/graph.py). Every LLM call this node makes
(capability_selector_agent, promise_options_agent, scenario_comparison_agent)
is mocked at its app.graph.* import location — same established convention
as test_production_planning_agent.py mocking app.graph.intent_agent/
context_agent. This keeps these tests deterministic, fast, and immune to
Groq's real daily rate limit (hit for real during this session's own full
regression run).

The deterministic plan-simulation helpers
(_plan_production_via_manufacturing_services / _plan_vendor_sourcing) are
also mocked at their app.graph.* location — they are pre-existing,
already-tested functions; these tests are about promise_reasoning_node's
OWN new orchestration behavior, not re-proving those functions work.
"""
from unittest.mock import AsyncMock, patch

import pytest

from app.capabilities.schemas import CapabilityCall, CapabilityResult, CapabilitySpec
from app.graph import promise_reasoning_node
from app.schemas.promise import CapabilityDecision, PromiseOptionsDecision, ScenarioComparisonDecision


def _base_state(**overrides) -> dict:
    state = {
        "user_message": "Can we deliver 500 units of Cable Management Kit to Acme Corp by Friday?",
        "customer_id": "C001",
        "customer_name": "Acme Corp",
        "customer_active": True,
        "customer_credit_limit": 100_000.0,
        "product_id": "P001",
        "product_name": "Cable Management Kit",
        "quantity": 500,
        "requested_deadline": "2026-12-05",
        "price": 10.0,
        "can_produce": True,
        "product_configurable": False,
        "lead_time_days": 5,
        "stock": [],
    }
    state.update(overrides)
    return state


def _decision(**kwargs) -> CapabilityDecision:
    defaults = {"action": "sufficient_information", "capability": None, "reason": "enough", "clarification_question": None}
    defaults.update(kwargs)
    return CapabilityDecision(**defaults)


# ---------------------------------------------------------------------------
# UNIT TESTS (brief §17)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_missing_product_or_quantity_asks_for_clarification_without_calling_any_llm():
    state = _base_state(product_id=None)
    with patch("app.graph.capability_selector_agent") as selector:
        result = await promise_reasoning_node(state)
    selector.assert_not_called()
    assert result["status"] == "NEEDS_CLARIFICATION"
    assert result["needs_clarification"] is True


@pytest.mark.asyncio
async def test_agent_selects_inventory_inspection_for_an_inventory_dependent_goal():
    state = _base_state()
    selector = AsyncMock(side_effect=[
        _decision(action="call_capability", capability="inspect_inventory", reason="need real stock before anything else"),
        _decision(action="sufficient_information"),
    ])
    with patch("app.graph.capability_selector_agent", selector), \
         patch("app.graph.dispatch", AsyncMock(return_value=CapabilityResult(
             capability="inspect_inventory", success=True, authoritative_source="mock-erp:Stock",
             data={"product_id": "P001", "stock_total": 500, "by_location": []},
         ))) as dispatch_mock, \
         patch("app.graph.promise_options_agent", AsyncMock(return_value=PromiseOptionsDecision(alternatives_to_investigate=[], reasoning="stock covers it"))), \
         patch("app.graph.scenario_comparison_agent", AsyncMock(return_value=ScenarioComparisonDecision(recommended_scenario_id="STOCK_PLUS_PRODUCTION", reasoning="covered by stock"))), \
         patch("app.config.MANUFACTURING_PRODUCT_IDS", {"Cable Management Kit": "mfg-product-1"}), \
         patch("app.graph.execute_action_plan", return_value={"status": "COMPLETED", "executed": [], "skipped": [], "pending_action": None}):
        result = await promise_reasoning_node(state)

    dispatched_names = [call.args[0].capability for call in dispatch_mock.call_args_list]
    assert "inspect_inventory" in dispatched_names
    assert result["promise_tool_call_count"] == 1


@pytest.mark.asyncio
async def test_agent_selects_capacity_assessment_when_capacity_matters():
    state = _base_state()
    selector = AsyncMock(side_effect=[
        _decision(action="call_capability", capability="assess_capacity", reason="check real plant workload"),
        _decision(action="sufficient_information"),
    ])
    with patch("app.graph.capability_selector_agent", selector), \
         patch("app.graph.dispatch", AsyncMock(return_value=CapabilityResult(
             capability="assess_capacity", success=True, authoritative_source="scheduling-service:capacity", data={"utilization": 0.8},
         ))) as dispatch_mock, \
         patch("app.graph.promise_options_agent", AsyncMock(return_value=PromiseOptionsDecision(alternatives_to_investigate=[], reasoning="x"))), \
         patch("app.graph.scenario_comparison_agent", AsyncMock(return_value=ScenarioComparisonDecision(recommended_scenario_id="STOCK_PLUS_PRODUCTION", reasoning="x"))), \
         patch("app.config.MANUFACTURING_PRODUCT_IDS", {"Cable Management Kit": "mfg-product-1"}), \
         patch("app.graph._plan_production_via_manufacturing_services", AsyncMock(return_value=_plan(quantity=500))), \
         patch("app.graph.execute_action_plan", return_value={"status": "COMPLETED", "executed": [], "skipped": [], "pending_action": None}):
        result = await promise_reasoning_node(state)

    dispatched_names = [call.args[0].capability for call in dispatch_mock.call_args_list]
    assert "assess_capacity" in dispatched_names
    assert result["promise_tool_call_count"] == 1


@pytest.mark.asyncio
async def test_agent_does_not_call_an_unauthorized_or_already_called_capability():
    state = _base_state()
    # First call legitimately investigates inventory; second call tries to
    # name a capability that does not exist at all — must be rejected, not
    # dispatched, and the loop must continue rather than crash.
    selector = AsyncMock(side_effect=[
        _decision(action="call_capability", capability="inspect_inventory", reason="x"),
        _decision(action="call_capability", capability="delete_everything", reason="malicious or hallucinated"),
        _decision(action="sufficient_information"),
    ])
    with patch("app.graph.capability_selector_agent", selector), \
         patch("app.graph.dispatch", AsyncMock(return_value=CapabilityResult(
             capability="inspect_inventory", success=True, authoritative_source="mock-erp:Stock", data={"stock_total": 500},
         ))) as dispatch_mock, \
         patch("app.graph.promise_options_agent", AsyncMock(return_value=PromiseOptionsDecision(alternatives_to_investigate=[], reasoning="x"))), \
         patch("app.graph.scenario_comparison_agent", AsyncMock(return_value=ScenarioComparisonDecision(recommended_scenario_id="STOCK_PLUS_PRODUCTION", reasoning="x"))), \
         patch("app.config.MANUFACTURING_PRODUCT_IDS", {"Cable Management Kit": "mfg-product-1"}), \
         patch("app.graph.execute_action_plan", return_value={"status": "COMPLETED", "executed": [], "skipped": [], "pending_action": None}):
        result = await promise_reasoning_node(state)

    dispatched_names = [call.args[0].capability for call in dispatch_mock.call_args_list]
    assert dispatched_names == ["inspect_inventory"]  # delete_everything never reached dispatch
    rejected_entries = [t for t in result["promise_trace"] if "rejected" in t]
    assert len(rejected_entries) == 1


@pytest.mark.asyncio
async def test_consequential_capabilities_are_never_offered_to_the_selector():
    state = _base_state()
    seen_capability_names: list[str] = []

    async def _capture_offered(goal, observations, available):
        seen_capability_names.extend(spec.name for spec in available)
        return _decision(action="sufficient_information")

    with patch("app.graph.capability_selector_agent", _capture_offered), \
         patch("app.graph.promise_options_agent", AsyncMock(return_value=PromiseOptionsDecision(alternatives_to_investigate=[], reasoning="x"))), \
         patch("app.graph.scenario_comparison_agent", AsyncMock(return_value=ScenarioComparisonDecision(recommended_scenario_id=None, reasoning="x"))), \
         patch("app.config.MANUFACTURING_PRODUCT_IDS", {}):
        await promise_reasoning_node(state)

    assert "execute_approved_plan" not in seen_capability_names
    assert "request_human_approval" not in seen_capability_names
    assert "simulate_schedule" not in seen_capability_names  # reserved for the alternative-simulation phase
    assert "inspect_affected_orders" not in seen_capability_names  # no production_order_id exists yet


@pytest.mark.asyncio
async def test_maximum_iteration_limit_is_enforced():
    state = _base_state()
    # Five fake, always-distinct "investigate" capabilities — strictly
    # more than MAX_PROMISE_REASONING_ITERATIONS (4) — so the loop would
    # keep going past the cap if the cap itself were not enforced.
    fake_specs = [
        CapabilitySpec(name=f"_fake_{i}", description="x", read_write="read", authoritative_source="x", timeout_seconds=1.0, phase="investigate")
        for i in range(5)
    ]
    always_call_next = AsyncMock(side_effect=[
        _decision(action="call_capability", capability=f"_fake_{i}", reason="x") for i in range(5)
    ])
    with patch("app.graph.investigable_capabilities", return_value=fake_specs), \
         patch("app.graph.capability_selector_agent", always_call_next), \
         patch("app.graph.dispatch", AsyncMock(return_value=CapabilityResult(capability="_fake", success=True, authoritative_source="x"))), \
         patch("app.graph.promise_options_agent", AsyncMock(return_value=PromiseOptionsDecision(alternatives_to_investigate=[], reasoning="x"))), \
         patch("app.graph.scenario_comparison_agent", AsyncMock(return_value=ScenarioComparisonDecision(recommended_scenario_id="STOCK_PLUS_PRODUCTION", reasoning="x"))), \
         patch("app.config.MANUFACTURING_PRODUCT_IDS", {"Cable Management Kit": "mfg-product-1"}), \
         patch("app.graph._plan_production_via_manufacturing_services", AsyncMock(return_value=_plan(quantity=500))), \
         patch("app.graph.mfg.delete_production_order", AsyncMock()), \
         patch("app.graph.execute_action_plan", return_value={"status": "COMPLETED", "executed": [], "skipped": [], "pending_action": None}):
        result = await promise_reasoning_node(state)

    assert result["promise_iteration_count"] <= 4
    assert result["promise_tool_call_count"] <= 4


@pytest.mark.asyncio
async def test_maximum_tool_call_limit_is_enforced_independently_of_iteration_count():
    from app import graph as graph_module

    state = _base_state()
    with patch.object(graph_module, "MAX_PROMISE_TOOL_CALLS", 1), \
         patch("app.graph.capability_selector_agent", AsyncMock(side_effect=[
             _decision(action="call_capability", capability="inspect_customer", reason="x"),
             _decision(action="call_capability", capability="inspect_inventory", reason="x"),
         ])), \
         patch("app.graph.dispatch", AsyncMock(return_value=CapabilityResult(capability="x", success=True, authoritative_source="x"))) as dispatch_mock, \
         patch("app.graph.promise_options_agent", AsyncMock(return_value=PromiseOptionsDecision(alternatives_to_investigate=[], reasoning="x"))), \
         patch("app.graph.scenario_comparison_agent", AsyncMock(return_value=ScenarioComparisonDecision(recommended_scenario_id="STOCK_PLUS_PRODUCTION", reasoning="x"))), \
         patch("app.config.MANUFACTURING_PRODUCT_IDS", {"Cable Management Kit": "mfg-product-1"}), \
         patch("app.graph._plan_production_via_manufacturing_services", AsyncMock(return_value=_plan(quantity=500))), \
         patch("app.graph.mfg.delete_production_order", AsyncMock()), \
         patch("app.graph.execute_action_plan", return_value={"status": "COMPLETED", "executed": [], "skipped": [], "pending_action": None}):
        await promise_reasoning_node(state)

    assert dispatch_mock.call_count == 1


@pytest.mark.asyncio
async def test_a_capability_timeout_during_investigation_does_not_crash_the_node():
    state = _base_state()
    with patch("app.graph.capability_selector_agent", AsyncMock(side_effect=[
             _decision(action="call_capability", capability="inspect_inventory", reason="x"),
             _decision(action="sufficient_information"),
         ])), \
         patch("app.graph.dispatch", AsyncMock(return_value=CapabilityResult(
             capability="inspect_inventory", success=False, authoritative_source="mock-erp:Stock", errors={"reason": "Timed out after 5.0s."},
         ))), \
         patch("app.graph.promise_options_agent", AsyncMock(return_value=PromiseOptionsDecision(alternatives_to_investigate=[], reasoning="x"))), \
         patch("app.graph.scenario_comparison_agent", AsyncMock(return_value=ScenarioComparisonDecision(recommended_scenario_id=None, reasoning="could not verify stock"))), \
         patch("app.config.MANUFACTURING_PRODUCT_IDS", {}):
        result = await promise_reasoning_node(state)

    assert result["status"] == "COMPLETED"
    assert "No feasible option" in result["response"]


def _plan(*, quantity: int, verdict: str = "PASS", scheduled_end: str = "2026-12-04T10:00:00Z") -> dict:
    return {
        "verdict": verdict,
        "explanation": "ok",
        "materials": [],
        "routing_operations": [{"operation_id": "op1"}],
        "simulated_operations": [{"operation": "op1", "scheduled_start": "2026-12-01T08:00:00Z", "scheduled_end": scheduled_end}] if verdict != "MATERIAL_SHORTAGE" else [],
        "production_order_id": "PO-TEST-1",
        "plant_id": "PLANT-1",
        "quantity": quantity,
    }


# ---------------------------------------------------------------------------
# SCENARIO TESTS (brief §17)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fully_feasible_friday_delivery_from_stock_alone():
    state = _base_state(stock=[{"stock_qty": 500}])
    with patch("app.graph.capability_selector_agent", AsyncMock(side_effect=[
             _decision(action="call_capability", capability="inspect_inventory", reason="check real stock before promising"),
             _decision(action="sufficient_information"),
         ])), \
         patch("app.graph.dispatch", AsyncMock(return_value=CapabilityResult(
             capability="inspect_inventory", success=True, authoritative_source="mock-erp:Stock", data={"stock_total": 500},
         ))), \
         patch("app.graph.promise_options_agent", AsyncMock(return_value=PromiseOptionsDecision(alternatives_to_investigate=[], reasoning="stock alone covers it"))), \
         patch("app.graph.scenario_comparison_agent", AsyncMock(return_value=ScenarioComparisonDecision(recommended_scenario_id="STOCK_PLUS_PRODUCTION", reasoning="fully covered by stock, no production needed"))), \
         patch("app.config.MANUFACTURING_PRODUCT_IDS", {}), \
         patch("app.graph.execute_action_plan", return_value={
             "status": "AWAITING_APPROVAL", "executed": [{"action": "check_credit", "result": {"checked": True}, "succeeded": True},
                                                            {"action": "check_stock", "result": {}, "succeeded": True}],
             "skipped": [], "pending_action": {"action": "create_order", "context": {"customer_id": "C001"}},
         }):
        result = await promise_reasoning_node(state)

    assert result["status"] == "AWAITING_APPROVAL"
    recommended = result["promise_recommendation"]["scenario"]
    assert recommended["feasible"] is True
    assert recommended["quantity_from_stock"] == 500
    assert recommended["quantity_to_make"] == 0
    assert result["pending_approval"]["context"]["fulfillment"]["strategy"] == "MTS"


@pytest.mark.asyncio
async def test_stock_shortage_generates_make_and_vendor_alternatives():
    state = _base_state(stock=[{"stock_qty": 100}])
    with patch("app.graph.capability_selector_agent", AsyncMock(return_value=_decision(action="sufficient_information"))), \
         patch("app.graph.dispatch", AsyncMock(return_value=CapabilityResult(
             capability="inspect_inventory", success=True, authoritative_source="mock-erp:Stock", data={"stock_total": 100},
         ))), \
         patch("app.graph.promise_options_agent", AsyncMock(return_value=PromiseOptionsDecision(
             alternatives_to_investigate=["PRODUCTION_ONLY", "VENDOR"], reasoning="stock covers only 100 of 500"))), \
         patch("app.graph.scenario_comparison_agent", AsyncMock(return_value=ScenarioComparisonDecision(
             recommended_scenario_id="PRODUCTION_ONLY", reasoning="production meets the date, vendor is unnecessary"))), \
         patch("app.config.MANUFACTURING_PRODUCT_IDS", {"Cable Management Kit": "mfg-product-1"}), \
         patch("app.graph._plan_production_via_manufacturing_services", AsyncMock(return_value=_plan(quantity=500))), \
         patch("app.graph._plan_vendor_sourcing", AsyncMock(return_value={"vendors_available": True, "vendor_id": "V1", "vendor_name": "Vendor Co", "unit_cost": 5.0, "lead_time_days": 3, "drop_ship": False, "target_completion_date": "2026-12-03"})), \
         patch("app.graph.mfg.delete_production_order", AsyncMock()) as delete_mock, \
         patch("app.graph.execute_action_plan", return_value={
             "status": "AWAITING_APPROVAL", "executed": [], "skipped": [],
             "pending_action": {"action": "create_order", "context": {"customer_id": "C001"}},
         }):
        result = await promise_reasoning_node(state)

    scenario_ids = {s["scenario_id"] for s in result["promise_scenarios"]}
    assert {"STOCK_PLUS_PRODUCTION", "PRODUCTION_ONLY", "VENDOR"}.issubset(scenario_ids)
    # The non-chosen scenarios' draft ProductionOrders must be cleaned up —
    # STOCK_PLUS_PRODUCTION also calls production (quantity_to_make=400>0),
    # so it too created PO-TEST-1 in this mock and must be cleaned up.
    assert delete_mock.await_count >= 1


@pytest.mark.asyncio
async def test_capacity_shortage_leads_to_a_later_date_alternative():
    state = _base_state(stock=[{"stock_qty": 0}])
    later_plan = _plan(quantity=500, scheduled_end="2026-12-10T10:00:00Z")
    with patch("app.graph.capability_selector_agent", AsyncMock(return_value=_decision(action="sufficient_information"))), \
         patch("app.graph.dispatch", AsyncMock(return_value=CapabilityResult(
             capability="inspect_inventory", success=True, authoritative_source="mock-erp:Stock", data={"stock_total": 0},
         ))), \
         patch("app.graph.promise_options_agent", AsyncMock(return_value=PromiseOptionsDecision(
             alternatives_to_investigate=["LATER_DATE"], reasoning="requested date looks tight"))), \
         patch("app.graph.scenario_comparison_agent", AsyncMock(return_value=ScenarioComparisonDecision(
             recommended_scenario_id="LATER_DATE", reasoning="only the later date is feasible"))), \
         patch("app.config.MANUFACTURING_PRODUCT_IDS", {"Cable Management Kit": "mfg-product-1"}), \
         patch("app.graph._plan_production_via_manufacturing_services", AsyncMock(side_effect=[
             _plan(quantity=500, scheduled_end="2026-12-10T10:00:00Z"),  # STOCK_PLUS_PRODUCTION leg (against Friday, misses it)
             later_plan,  # LATER_DATE leg
         ])), \
         patch("app.graph.mfg.delete_production_order", AsyncMock()), \
         patch("app.graph.execute_action_plan", return_value={
             "status": "AWAITING_APPROVAL", "executed": [], "skipped": [],
             "pending_action": {"action": "create_order", "context": {"customer_id": "C001"}},
         }):
        result = await promise_reasoning_node(state)

    later_scenario = next(s for s in result["promise_scenarios"] if s["scenario_id"] == "LATER_DATE")
    assert later_scenario["requested_delivery_date"] == "2026-12-12"  # requested_deadline + 7 days
    assert result["promise_recommendation"]["scenario"]["scenario_id"] == "LATER_DATE"


@pytest.mark.asyncio
async def test_no_feasible_option_is_reported_honestly_not_coerced_to_feasible():
    state = _base_state(stock=[{"stock_qty": 0}])
    with patch("app.graph.capability_selector_agent", AsyncMock(return_value=_decision(action="sufficient_information"))), \
         patch("app.graph.dispatch", AsyncMock(return_value=CapabilityResult(
             capability="inspect_inventory", success=True, authoritative_source="mock-erp:Stock", data={"stock_total": 0},
         ))), \
         patch("app.graph.promise_options_agent", AsyncMock(return_value=PromiseOptionsDecision(alternatives_to_investigate=["VENDOR"], reasoning="x"))), \
         patch("app.graph.scenario_comparison_agent", AsyncMock(return_value=ScenarioComparisonDecision(recommended_scenario_id=None, reasoning="nothing meets the date or has material"))), \
         patch("app.config.MANUFACTURING_PRODUCT_IDS", {"Cable Management Kit": "mfg-product-1"}), \
         patch("app.graph._plan_production_via_manufacturing_services", AsyncMock(return_value=_plan(quantity=500, verdict="MATERIAL_SHORTAGE"))), \
         patch("app.graph._plan_vendor_sourcing", AsyncMock(return_value={"vendors_available": False})):
        result = await promise_reasoning_node(state)

    assert result["status"] == "COMPLETED"
    assert "No feasible option" in result["response"]
    assert "pending_approval" not in result  # nothing is ever raised for approval when nothing is feasible


@pytest.mark.asyncio
async def test_multiple_feasible_options_are_compared_and_the_llm_recommendation_is_honored():
    state = _base_state(stock=[{"stock_qty": 500}])
    with patch("app.graph.capability_selector_agent", AsyncMock(return_value=_decision(action="sufficient_information"))), \
         patch("app.graph.dispatch", AsyncMock(return_value=CapabilityResult(
             capability="inspect_inventory", success=True, authoritative_source="mock-erp:Stock", data={"stock_total": 500},
         ))), \
         patch("app.graph.promise_options_agent", AsyncMock(return_value=PromiseOptionsDecision(alternatives_to_investigate=["PRODUCTION_ONLY"], reasoning="compare against production too"))), \
         patch("app.graph.scenario_comparison_agent", AsyncMock(return_value=ScenarioComparisonDecision(recommended_scenario_id="STOCK_PLUS_PRODUCTION", reasoning="stock avoids any production risk"))), \
         patch("app.config.MANUFACTURING_PRODUCT_IDS", {"Cable Management Kit": "mfg-product-1"}), \
         patch("app.graph._plan_production_via_manufacturing_services", AsyncMock(return_value=_plan(quantity=500))), \
         patch("app.graph.mfg.delete_production_order", AsyncMock()) as delete_mock, \
         patch("app.graph.execute_action_plan", return_value={
             "status": "AWAITING_APPROVAL", "executed": [], "skipped": [],
             "pending_action": {"action": "create_order", "context": {"customer_id": "C001"}},
         }):
        result = await promise_reasoning_node(state)

    assert len(result["promise_scenarios"]) == 2
    assert result["promise_recommendation"]["scenario"]["scenario_id"] == "STOCK_PLUS_PRODUCTION"
    delete_mock.assert_awaited()  # the non-chosen PRODUCTION_ONLY scenario's draft order is cleaned up


@pytest.mark.asyncio
async def test_chosen_scenarios_production_plan_is_field_compatible_with_real_post_approval_execution():
    """Regression test for a real bug caught during this phase's own
    manual trace-through: _execute_production_plan (the function
    run_post_approval_fulfillment's "replay, not re-decision" branch calls
    after approval) does `production_plan["verdict"]` as a direct key
    access, not a .get() — a production_plan dict built from only
    {production_order_id, plant_id, quantity} (this phase's first draft)
    would KeyError here, post-approval, with real money already
    committed to a real SalesOrder. This proves the fix: the scenario's
    production_plan is the exact, full dict _plan_production_via_
    manufacturing_services returns, not a reconstructed subset."""
    from app.graph import _execute_production_plan

    state = _base_state(stock=[{"stock_qty": 0}])
    with patch("app.graph.capability_selector_agent", AsyncMock(return_value=_decision(action="sufficient_information"))), \
         patch("app.graph.dispatch", AsyncMock(return_value=CapabilityResult(
             capability="inspect_inventory", success=True, authoritative_source="mock-erp:Stock", data={"stock_total": 0},
         ))), \
         patch("app.graph.promise_options_agent", AsyncMock(return_value=PromiseOptionsDecision(alternatives_to_investigate=[], reasoning="x"))), \
         patch("app.graph.scenario_comparison_agent", AsyncMock(return_value=ScenarioComparisonDecision(recommended_scenario_id="STOCK_PLUS_PRODUCTION", reasoning="x"))), \
         patch("app.config.MANUFACTURING_PRODUCT_IDS", {"Cable Management Kit": "mfg-product-1"}), \
         patch("app.graph._plan_production_via_manufacturing_services", AsyncMock(return_value=_plan(quantity=500))), \
         patch("app.graph.execute_action_plan", return_value={
             "status": "AWAITING_APPROVAL", "executed": [], "skipped": [],
             "pending_action": {"action": "create_order", "context": {"customer_id": "C001"}},
         }):
        result = await promise_reasoning_node(state)

    production_plan = result["pending_approval"]["context"]["production_plan"]
    assert "verdict" in production_plan  # the exact field that KeyError'd before this fix

    sim_state = {
        "sales_order_id": "SO-TEST", "response": "", "fulfillment_line_ids": {}, "real_sales_order_id": None,
        "customer_id": "C001", "customer_name": "Acme Corp", "product_id": "P001", "product_name": "Cable Management Kit", "price": 10.0,
    }
    with patch("app.graph._commit_production_plan", AsyncMock(return_value={
        "production_order_id": production_plan["production_order_id"], "status": "RELEASED", "scheduled_operations": [],
    })):
        execution_result = await _execute_production_plan(sim_state, production_plan)  # must not raise KeyError

    assert execution_result["status"] in ("IN_PRODUCTION", "AWAITING_MATERIALS")
