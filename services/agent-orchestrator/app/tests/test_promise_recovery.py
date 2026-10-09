# app/tests/test_promise_recovery.py
"""Phase 11 (Promise Monitoring & Agentic Recovery) — tests for the
PROMISE_RECOVERY branch of promise_reasoning_node (_run_promise_recovery_scenarios),
the new /disruptions/evaluate router, and the post-reschedule goal-
satisfaction check in approvals.py. Every LLM call is mocked at its
app.graph.* import location — same convention as test_promise_reasoning.py,
immune to Groq's real rate limit."""
import os
from unittest.mock import AsyncMock, patch

import pytest

os.environ.setdefault("INTERNAL_SERVICE_TOKEN", "test-token-for-promise-recovery-tests")

from fastapi.testclient import TestClient

from app import db
from app.approval_proposal import compute_proposal_hash
from app.graph import _run_promise_recovery_scenarios, _simulate_reschedule_recovery, promise_reasoning_node
from app.integrations.manufacturing_services import AGENT_ORCHESTRATOR_ENTERPRISE_ID
from app.main import app
from app.routers.approvals import _evaluate_reschedule_goal_satisfaction
from app.schemas.promise import PromiseOptionsDecision, ScenarioComparisonDecision

client = TestClient(app)
TOKEN = os.environ["INTERNAL_SERVICE_TOKEN"]
HEADERS = {"x-internal-token": TOKEN, "x-forwarded-user": "test-planner", "x-forwarded-role": "PLANNER"}


def _recovery_goal(**overrides) -> dict:
    goal = {
        "goal_type": "PROMISE_RECOVERY",
        "customer_name": "Acme Corp",
        "product_name": "Cable Management Kit",
        "product_id": "P001",
        "quantity": 500,
        "requested_deadline": "2026-12-05",
        "disruption": {"type": "MACHINE_BREAKDOWN", "resource": "M-104"},
        "current_result": {"promised_date": "2026-12-10", "feasible": False},
        "production_order_id": "po-disrupted-1",
        "plant_id": "plant-1",
        "sales_order_id": "SO-1042",
    }
    goal.update(overrides)
    return goal


# Phase 13 — realistic mock shapes for the two new real calls
# _simulate_reschedule_recovery makes. current_order mirrors order-service's
# real GET /orders/:id (the scheduledOperations count is the "how many
# operations does this order actually have" floor); whatif mirrors
# scheduling-service's real POST /scheduling/what-if PipelineResult shape.
def _current_order(scheduled_op_count: int = 2) -> dict:
    return {"id": "po-disrupted-1", "scheduledOperations": [{"scheduledEnd": "2026-12-10T10:00:00Z"} for _ in range(scheduled_op_count)]}


def _whatif_result(production_order_id: str, ends: list[str], scope: str = "AFFECTED") -> dict:
    return {
        "runId": "whatif-test", "ordersProcessed": 1, "operationsScheduled": len(ends), "conflictsDetected": 0,
        "scheduleVersion": 0, "scope": scope, "scopedOrderIds": [production_order_id],
        "simulatedOperations": [
            {"productionOrderId": production_order_id, "routingOperationId": f"op-{i}", "machineId": "m-1", "scheduledStart": end, "scheduledEnd": end}
            for i, end in enumerate(ends)
        ],
    }


# ---------------------------------------------------------------------------
# UNIT TESTS
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_promise_breached_starts_recovery_reasoning_and_recommends_reschedule():
    goal = _recovery_goal()
    with patch("app.graph.promise_options_agent", AsyncMock(return_value=PromiseOptionsDecision(
             alternatives_to_investigate=["RESCHEDULE_BOTTLENECK"], reasoning="worth attempting"))), \
         patch("app.graph.scenario_comparison_agent", AsyncMock(return_value=ScenarioComparisonDecision(
             recommended_scenario_id="RESCHEDULE_BOTTLENECK", reasoning="only real recovery action available"))), \
         patch("app.graph.mfg.get_affected_orders_preview", AsyncMock(return_value={"scopedOrderIds": ["po-disrupted-1", "po-2"]})), \
         patch("app.graph.mfg.get_production_order", AsyncMock(return_value=_current_order(2))), \
         patch("app.graph.mfg.simulate_reschedule", AsyncMock(return_value=_whatif_result("po-disrupted-1", ["2026-12-04T10:00:00Z", "2026-12-04T12:00:00Z"]))):
        result = await _run_promise_recovery_scenarios(goal, [], 0, 0)

    assert result["status"] == "AWAITING_APPROVAL"
    assert result["pending_approval"]["action"] == "RESCHEDULE_PRODUCTION"
    assert result["pending_approval"]["context"]["production_order_id"] == "po-disrupted-1"
    assert result["pending_approval"]["context"]["scope"] == "AFFECTED"
    assert result["pending_approval"]["context"]["mode"] == "BOTTLENECK"
    assert result["pending_approval"]["context"]["original_promised_date"] == "2026-12-05"
    # Phase 13 — the real simulation result, not a placeholder.
    recommended = result["promise_recommendation"]["scenario"]
    assert recommended["feasible"] is True
    assert recommended["promise_restored"] is True
    assert recommended["projected_delivery_date"] == "2026-12-04"


@pytest.mark.asyncio
async def test_llm_cannot_fabricate_feasibility_when_the_real_simulation_fails():
    """brief §8/§9 — when the real deterministic simulation itself cannot
    run (e.g. the production order can no longer be read), feasible stays
    None for an honest, specific reason — the recommendation step must
    never flip that to True."""
    goal = _recovery_goal()
    with patch("app.graph.promise_options_agent", AsyncMock(return_value=PromiseOptionsDecision(
             alternatives_to_investigate=["RESCHEDULE_BOTTLENECK"], reasoning="x"))), \
         patch("app.graph.scenario_comparison_agent", AsyncMock(return_value=ScenarioComparisonDecision(
             recommended_scenario_id="RESCHEDULE_BOTTLENECK", reasoning="x"))), \
         patch("app.graph.mfg.get_affected_orders_preview", AsyncMock(return_value={})), \
         patch("app.graph.mfg.get_production_order", AsyncMock(side_effect=RuntimeError("not found"))):
        result = await _run_promise_recovery_scenarios(goal, [], 0, 0)

    recommended_scenario = result["promise_recommendation"]["scenario"]
    assert recommended_scenario["feasible"] is None  # never coerced to True, even though it was recommended
    assert "Could not read the current production order" in recommended_scenario["failure_reason"]


@pytest.mark.asyncio
async def test_llm_cannot_override_a_real_infeasible_simulation_result():
    """The complementary case: a real simulation that genuinely could not
    place the order's operations must stay feasible: False no matter what
    the LLM recommends — never upgraded to true or null."""
    goal = _recovery_goal()
    with patch("app.graph.promise_options_agent", AsyncMock(return_value=PromiseOptionsDecision(
             alternatives_to_investigate=["RESCHEDULE_BOTTLENECK"], reasoning="x"))), \
         patch("app.graph.scenario_comparison_agent", AsyncMock(return_value=ScenarioComparisonDecision(
             recommended_scenario_id="RESCHEDULE_BOTTLENECK", reasoning="worth trying anyway"))), \
         patch("app.graph.mfg.get_affected_orders_preview", AsyncMock(return_value={})), \
         patch("app.graph.mfg.get_production_order", AsyncMock(return_value=_current_order(2))), \
         patch("app.graph.mfg.simulate_reschedule", AsyncMock(return_value=_whatif_result("some-other-order", ["2026-12-04T10:00:00Z"]))):
        result = await _run_promise_recovery_scenarios(goal, [], 0, 0)

    recommended_scenario = result["promise_recommendation"]["scenario"]
    assert recommended_scenario["feasible"] is False  # this order's own operations never appeared in simulatedOperations
    assert recommended_scenario["promise_restored"] is False
    assert "could not place any" in recommended_scenario["failure_reason"]


@pytest.mark.asyncio
async def test_feasible_but_promise_not_restored_is_a_real_distinct_outcome():
    """A reschedule can succeed (every operation placed) while still
    landing after the original promise — this must be reported as its
    own real outcome, not silently folded into "feasible" or
    "infeasible"."""
    goal = _recovery_goal()
    with patch("app.graph.promise_options_agent", AsyncMock(return_value=PromiseOptionsDecision(
             alternatives_to_investigate=["RESCHEDULE_BOTTLENECK"], reasoning="x"))), \
         patch("app.graph.scenario_comparison_agent", AsyncMock(return_value=ScenarioComparisonDecision(
             recommended_scenario_id="RESCHEDULE_BOTTLENECK", reasoning="x"))), \
         patch("app.graph.mfg.get_affected_orders_preview", AsyncMock(return_value={})), \
         patch("app.graph.mfg.get_production_order", AsyncMock(return_value=_current_order(1))), \
         patch("app.graph.mfg.simulate_reschedule", AsyncMock(return_value=_whatif_result("po-disrupted-1", ["2026-12-08T10:00:00Z"]))):
        result = await _run_promise_recovery_scenarios(goal, [], 0, 0)

    recommended_scenario = result["promise_recommendation"]["scenario"]
    assert recommended_scenario["feasible"] is True
    assert recommended_scenario["promise_restored"] is False  # 12/08 is still after the 12/05 promise
    assert "still after the original promise" in recommended_scenario["failure_reason"]


@pytest.mark.asyncio
async def test_no_recovery_option_investigated_reports_honest_failure_not_success():
    """brief §22's third required test: 'Original promise cannot currently
    be recovered' — NOT 'Recovery successful.'"""
    goal = _recovery_goal()
    with patch("app.graph.promise_options_agent", AsyncMock(return_value=PromiseOptionsDecision(
             alternatives_to_investigate=[], reasoning="nothing worth investigating"))), \
         patch("app.graph.scenario_comparison_agent", AsyncMock(return_value=ScenarioComparisonDecision(
             recommended_scenario_id="KEEP_CURRENT", reasoning="no recovery action available"))):
        result = await _run_promise_recovery_scenarios(goal, [], 0, 0)

    assert result["status"] == "COMPLETED"
    assert "cannot currently be recovered" in result["response"]
    assert "pending_approval" not in result
    assert result["promise_recommendation"]["scenario"]["scenario_id"] == "KEEP_CURRENT"


@pytest.mark.asyncio
async def test_recovery_cannot_execute_before_approval():
    """No call to mfg.reschedule_production_order happens anywhere in the
    reasoning path — only resolve_reschedule_approval (a separate,
    human-gated endpoint) ever calls it."""
    goal = _recovery_goal()
    with patch("app.graph.promise_options_agent", AsyncMock(return_value=PromiseOptionsDecision(
             alternatives_to_investigate=["RESCHEDULE_BOTTLENECK"], reasoning="x"))), \
         patch("app.graph.scenario_comparison_agent", AsyncMock(return_value=ScenarioComparisonDecision(
             recommended_scenario_id="RESCHEDULE_BOTTLENECK", reasoning="x"))), \
         patch("app.graph.mfg.get_affected_orders_preview", AsyncMock(return_value={})), \
         patch("app.graph.mfg.get_production_order", AsyncMock(return_value=_current_order(1))), \
         patch("app.graph.mfg.simulate_reschedule", AsyncMock(return_value=_whatif_result("po-disrupted-1", ["2026-12-04T10:00:00Z"]))), \
         patch("app.graph.mfg.reschedule_production_order", AsyncMock()) as reschedule_mock:
        result = await _run_promise_recovery_scenarios(goal, [], 0, 0)

    reschedule_mock.assert_not_called()
    assert result["status"] == "AWAITING_APPROVAL"


@pytest.mark.asyncio
async def test_recovery_goal_reuses_the_same_capability_registry_as_order_promise():
    """brief §6/§21 — one reasoning mechanism, not a second agent. The
    full promise_reasoning_node (investigation loop included) runs for a
    PROMISE_RECOVERY goal exactly like it does for ORDER_PROMISE."""
    from app.capabilities.schemas import CapabilityResult
    from app.schemas.promise import CapabilityDecision

    state = {
        "customer_name": "Acme Corp", "product_name": "Cable Management Kit", "product_id": "P001",
        "quantity": 500, "requested_deadline": "2026-12-05",
        "promise_goal_type": "PROMISE_RECOVERY",
        "promise_disruption": {"type": "MACHINE_BREAKDOWN", "resource": "M-104"},
        "promise_current_result": {"promised_date": "2026-12-10", "feasible": False},
        "promise_production_order_id": "po-disrupted-1",
        "promise_plant_id": "plant-1",
        "promise_sales_order_id": "SO-1042",
    }
    offered_capabilities: list[str] = []

    async def _capture(goal, observations, available):
        offered_capabilities.extend(c.name for c in available)
        return CapabilityDecision(action="sufficient_information", reason="x")

    with patch("app.graph.capability_selector_agent", _capture), \
         patch("app.graph.promise_options_agent", AsyncMock(return_value=PromiseOptionsDecision(alternatives_to_investigate=[], reasoning="x"))), \
         patch("app.graph.scenario_comparison_agent", AsyncMock(return_value=ScenarioComparisonDecision(recommended_scenario_id="KEEP_CURRENT", reasoning="x"))), \
         patch("app.config.MANUFACTURING_PRODUCT_IDS", {"Cable Management Kit": "mfg-product-1"}):
        await promise_reasoning_node(state)

    # inspect_affected_orders IS offered here (unlike ORDER_PROMISE) since
    # a real production_order_id already exists for this disrupted order.
    assert "inspect_affected_orders" in offered_capabilities
    assert "execute_approved_plan" not in offered_capabilities
    assert "request_human_approval" not in offered_capabilities


# ---------------------------------------------------------------------------
# PHASE 13 — _simulate_reschedule_recovery, tested directly (not only
# through the full recovery flow above) so each real outcome is pinned
# down precisely.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_simulate_reschedule_recovery_feasible_and_promise_restored():
    with patch("app.graph.mfg.get_production_order", AsyncMock(return_value=_current_order(2))), \
         patch("app.graph.mfg.simulate_reschedule", AsyncMock(return_value=_whatif_result("po-1", ["2026-12-03T10:00:00Z", "2026-12-04T10:00:00Z"]))):
        result = await _simulate_reschedule_recovery("plant-1", "po-1", "2026-12-05")

    assert result == {
        "feasible": True, "projected_delivery_date": "2026-12-04", "promise_restored": True,
        "failure_reason": None,
        "evidence": {"operations_simulated": 2, "operations_expected": 2, "scope": "AFFECTED", "scoped_order_ids": ["po-1"], "conflicts_detected": 0},
    }


@pytest.mark.asyncio
async def test_simulate_reschedule_recovery_feasible_but_not_restored():
    with patch("app.graph.mfg.get_production_order", AsyncMock(return_value=_current_order(1))), \
         patch("app.graph.mfg.simulate_reschedule", AsyncMock(return_value=_whatif_result("po-1", ["2026-12-09T10:00:00Z"]))):
        result = await _simulate_reschedule_recovery("plant-1", "po-1", "2026-12-05")

    assert result["feasible"] is True
    assert result["promise_restored"] is False
    assert result["projected_delivery_date"] == "2026-12-09"


@pytest.mark.asyncio
async def test_simulate_reschedule_recovery_no_operations_placed_is_infeasible():
    with patch("app.graph.mfg.get_production_order", AsyncMock(return_value=_current_order(2))), \
         patch("app.graph.mfg.simulate_reschedule", AsyncMock(return_value={"simulatedOperations": [], "scope": "AFFECTED"})):
        result = await _simulate_reschedule_recovery("plant-1", "po-1", "2026-12-05")

    assert result["feasible"] is False
    assert result["promise_restored"] is False
    assert result["projected_delivery_date"] is None


@pytest.mark.asyncio
async def test_simulate_reschedule_recovery_partial_placement_is_infeasible():
    """Only 1 of this order's real 3 operations got placed in the
    simulation — a real, deterministic "not everything fit" signal, not
    guessed."""
    with patch("app.graph.mfg.get_production_order", AsyncMock(return_value=_current_order(3))), \
         patch("app.graph.mfg.simulate_reschedule", AsyncMock(return_value=_whatif_result("po-1", ["2026-12-04T10:00:00Z"]))):
        result = await _simulate_reschedule_recovery("plant-1", "po-1", "2026-12-05")

    assert result["feasible"] is False
    assert "Only 1 of 3" in result["failure_reason"]


@pytest.mark.asyncio
async def test_simulate_reschedule_recovery_handles_a_what_if_timeout_or_transport_error_honestly():
    """Phase 16 (End-to-End Disruption Recovery Validation) — real gap
    found: every other failure mode of this call was tested
    (infeasible/partial placement), but a genuine timeout or network
    exception FROM the what-if call itself (scheduling-service slow/down)
    was not. feasible must land on None (unknown, not False — a timeout
    proves nothing about whether a reschedule would actually work) with
    an honest failure_reason, never a crash and never fabricated success."""
    with patch("app.graph.mfg.get_production_order", AsyncMock(return_value=_current_order(2))), \
         patch("app.graph.mfg.simulate_reschedule", AsyncMock(side_effect=TimeoutError("scheduling-service what-if timed out"))):
        result = await _simulate_reschedule_recovery("plant-1", "po-1", "2026-12-05")

    assert result["feasible"] is None
    assert result["promise_restored"] is None  # unknown, not disproven — a timeout answers nothing either way
    assert result["projected_delivery_date"] is None
    assert result["failure_reason"] is not None


@pytest.mark.asyncio
async def test_simulate_reschedule_recovery_never_touches_other_orders_results():
    """Operations belonging to OTHER orders in the AFFECTED scope must
    never be counted toward this order's own feasibility."""
    whatif = _whatif_result("po-1", ["2026-12-04T10:00:00Z"])
    whatif["simulatedOperations"].append({"productionOrderId": "po-OTHER", "routingOperationId": "op-x", "machineId": "m-2", "scheduledStart": "2026-12-01T00:00:00Z", "scheduledEnd": "2026-12-20T00:00:00Z"})
    with patch("app.graph.mfg.get_production_order", AsyncMock(return_value=_current_order(1))), \
         patch("app.graph.mfg.simulate_reschedule", AsyncMock(return_value=whatif)):
        result = await _simulate_reschedule_recovery("plant-1", "po-1", "2026-12-05")

    assert result["projected_delivery_date"] == "2026-12-04"  # not 12/20, which belongs to po-OTHER
    assert result["evidence"]["operations_simulated"] == 1


@pytest.mark.asyncio
async def test_simulate_reschedule_recovery_missing_ids_is_handled_honestly():
    result = await _simulate_reschedule_recovery(None, None, "2026-12-05")
    assert result["feasible"] is None
    assert result["failure_reason"] is not None


@pytest.mark.asyncio
async def test_simulate_reschedule_recovery_never_persists_anything():
    """brief's own central requirement: the simulation must not modify
    committed state. This test proves the function never calls any
    committing API (reschedule_production_order, update_production_order_*,
    create/delete_production_order) — only read/what-if calls."""
    with patch("app.graph.mfg.get_production_order", AsyncMock(return_value=_current_order(1))), \
         patch("app.graph.mfg.simulate_reschedule", AsyncMock(return_value=_whatif_result("po-1", ["2026-12-04T10:00:00Z"]))), \
         patch("app.graph.mfg.reschedule_production_order", AsyncMock(side_effect=AssertionError("must never commit"))) as commit_mock, \
         patch("app.graph.mfg.update_production_order_status", AsyncMock(side_effect=AssertionError("must never commit"))) as update_mock:
        await _simulate_reschedule_recovery("plant-1", "po-1", "2026-12-05")

    commit_mock.assert_not_called()
    update_mock.assert_not_called()


def test_evaluate_reschedule_goal_satisfaction_returns_none_for_non_recovery_proposals():
    import asyncio
    ctx = {"production_order_id": "po-1", "plant_id": "plant-1", "scope": "AFFECTED", "mode": "BOTTLENECK"}
    result = asyncio.run(_evaluate_reschedule_goal_satisfaction(ctx))
    assert result is None  # no original_promised_date -> not a recovery proposal, nothing to verify


def test_evaluate_reschedule_goal_satisfaction_restored():
    import asyncio
    ctx = {"production_order_id": "po-1", "original_promised_date": "2026-12-05", "requested_quantity": 500}
    with patch("app.routers.approvals.mfg.get_production_order", AsyncMock(return_value={
        "quantity": 500, "scheduledOperations": [{"scheduledEnd": "2026-12-04T10:00:00Z"}],
    })):
        result = asyncio.run(_evaluate_reschedule_goal_satisfaction(ctx))
    assert result["satisfied"] is True
    assert result["promised_date"] == "2026-12-04T10:00:00Z"


def test_evaluate_reschedule_goal_satisfaction_still_violated():
    """brief §14 — never mark RECOVERY_SUCCESS because the API call
    returned 200; the real new schedule still misses the original date."""
    import asyncio
    ctx = {"production_order_id": "po-1", "original_promised_date": "2026-12-05", "requested_quantity": 500}
    with patch("app.routers.approvals.mfg.get_production_order", AsyncMock(return_value={
        "quantity": 500, "scheduledOperations": [{"scheduledEnd": "2026-12-09T10:00:00Z"}],
    })):
        result = asyncio.run(_evaluate_reschedule_goal_satisfaction(ctx))
    assert result["satisfied"] is False


# ---------------------------------------------------------------------------
# /disruptions/evaluate ROUTER TESTS
# ---------------------------------------------------------------------------


def _disruption_event(**overrides) -> dict:
    event = {
        "event_id": "run-1:po-1",
        "trace_id": "trace-1",
        "disruption_type": "MACHINE_BREAKDOWN",
        "plant_id": "plant-1",
        "affected_resource_id": "M-104",
        "production_order_id": "po-disrupted-1",
        "product_id": "mfg-product-1",
        "customer_name": "Acme Corp",
        "requested_quantity": 500,
        "requested_date": "2026-12-05",
        "original_promised_date": "2026-12-05",
        "current_promised_date": "2026-12-10",
        "occurred_at": "2026-12-01T00:00:00Z",
    }
    event.update(overrides)
    return event


def test_disruption_endpoint_requires_service_token():
    resp = client.post("/disruptions/evaluate", json=_disruption_event())
    assert resp.status_code == 401


def test_disruption_endpoint_rejects_unmapped_product_honestly():
    resp = client.post("/disruptions/evaluate", json=_disruption_event(product_id="no-such-product"), headers=HEADERS)
    assert resp.status_code == 422
    assert "not mapped" in resp.json()["detail"]


def test_disruption_endpoint_starts_a_real_run_and_saves_a_pending_approval():
    with patch("app.routers.disruptions.MANUFACTURING_PRODUCT_IDS", {"Cable Management Kit": "mfg-product-1"}), \
         patch("app.routers.disruptions._PRODUCT_ID_TO_NAME", {"mfg-product-1": "Cable Management Kit"}), \
         patch("app.routers.disruptions.get_product", return_value={"product_id": "P001", "product_name": "Cable Management Kit"}), \
         patch("app.routers.disruptions.mfg.get_production_order", AsyncMock(return_value={"metadata": {"salesOrderId": "SO-1042"}})), \
         patch("app.routers.disruptions.promise_reasoning_node", AsyncMock(return_value={
             "status": "AWAITING_APPROVAL",
             "pending_approval": {"action": "RESCHEDULE_PRODUCTION", "context": {"production_order_id": "po-disrupted-1", "plant_id": "plant-1", "scope": "AFFECTED", "mode": "BOTTLENECK"}},
         })), \
         patch("app.db.create_run", AsyncMock(return_value="run-test-1")), \
         patch("app.db.log_stage", AsyncMock()), \
         patch("app.db.save_pending_approval", AsyncMock()) as save_mock, \
         patch("app.db.finish_run", AsyncMock()):
        resp = client.post("/disruptions/evaluate", json=_disruption_event(product_id="mfg-product-1"), headers=HEADERS)

    assert resp.status_code == 200
    assert resp.json()["status"] == "AWAITING_APPROVAL"
    save_mock.assert_awaited_once()


def test_disruption_endpoint_skips_a_duplicate_when_a_recovery_is_already_pending():
    """Phase 16 (End-to-End Disruption Recovery Validation) — the same
    real-world disruption reaching this endpoint twice (a redelivered
    Kafka message, or two different disruption types on the same
    resource) must never produce two separate pending RESCHEDULE_
    PRODUCTION approvals for the same production order. Reasoning is
    skipped entirely — not just the approval write — so a duplicate also
    never wastes an LLM call."""
    with patch("app.routers.disruptions._PRODUCT_ID_TO_NAME", {"mfg-product-1": "Cable Management Kit"}), \
         patch("app.routers.disruptions.get_product", return_value={"product_id": "P001", "product_name": "Cable Management Kit"}), \
         patch("app.db.has_pending_reschedule_approval", AsyncMock(return_value=True)), \
         patch("app.routers.disruptions.promise_reasoning_node", AsyncMock(side_effect=AssertionError("must not reason about a known duplicate"))), \
         patch("app.db.create_run", AsyncMock(side_effect=AssertionError("must not start a run for a known duplicate"))), \
         patch("app.db.save_pending_approval", AsyncMock()) as save_mock:
        resp = client.post("/disruptions/evaluate", json=_disruption_event(product_id="mfg-product-1", event_id="run-2:po-disrupted-1"), headers=HEADERS)

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "DUPLICATE_SKIPPED"
    assert body["run_id"] is None
    save_mock.assert_not_called()


def test_disruption_endpoint_reports_promise_remains_safe_without_an_approval():
    with patch("app.routers.disruptions._PRODUCT_ID_TO_NAME", {"mfg-product-1": "Cable Management Kit"}), \
         patch("app.routers.disruptions.get_product", return_value={"product_id": "P001", "product_name": "Cable Management Kit"}), \
         patch("app.routers.disruptions.mfg.get_production_order", AsyncMock(return_value={"metadata": {}})), \
         patch("app.routers.disruptions.promise_reasoning_node", AsyncMock(return_value={
             "status": "COMPLETED", "response": "The original promise cannot currently be recovered for this order.",
         })), \
         patch("app.db.create_run", AsyncMock(return_value="run-test-2")), \
         patch("app.db.log_stage", AsyncMock()), \
         patch("app.db.save_pending_approval", AsyncMock()) as save_mock, \
         patch("app.db.finish_run", AsyncMock()):
        resp = client.post("/disruptions/evaluate", json=_disruption_event(product_id="mfg-product-1"), headers=HEADERS)

    assert resp.status_code == 200
    assert resp.json()["status"] == "COMPLETED"
    save_mock.assert_not_called()


def test_disruption_endpoint_fails_honestly_when_reasoning_raises():
    with patch("app.routers.disruptions._PRODUCT_ID_TO_NAME", {"mfg-product-1": "Cable Management Kit"}), \
         patch("app.routers.disruptions.get_product", return_value={"product_id": "P001", "product_name": "Cable Management Kit"}), \
         patch("app.routers.disruptions.mfg.get_production_order", AsyncMock(return_value={"metadata": {}})), \
         patch("app.routers.disruptions.promise_reasoning_node", AsyncMock(side_effect=RuntimeError("groq exploded"))), \
         patch("app.db.create_run", AsyncMock(return_value="run-test-3")), \
         patch("app.db.finish_run", AsyncMock()) as finish_mock:
        resp = client.post("/disruptions/evaluate", json=_disruption_event(product_id="mfg-product-1"), headers=HEADERS)

    assert resp.status_code == 500
    finish_mock.assert_awaited_once_with("run-test-3", "FAILED")


# ---------------------------------------------------------------------------
# INTEGRATION TESTS — real Postgres (db.create_run/save_pending_approval/
# claim_approval), real /approvals/reschedule/resolve endpoint. Only the
# two genuinely external calls (mfg.get_production_order,
# mfg.reschedule_production_order) are mocked — same convention
# test_approval_state.py's own reschedule test already established.
# These are brief §22's full hero-scenario loop: approval -> real
# deterministic execution -> real observation -> deterministic
# goal_satisfaction, both the restored and the still-violated outcome.
# ---------------------------------------------------------------------------

_RECOVERY_RESCHEDULE_CONTEXT = {
    "sales_order_id": "SO-1042", "production_order_id": "po-disrupted-1",
    "plant_id": "plant-test-1", "kind": "optimize", "scope": "AFFECTED", "mode": "BOTTLENECK",
    "original_promised_date": "2026-12-05", "requested_quantity": 500,
}


async def _make_pending_reschedule(context: dict) -> str:
    run_id = await db.create_run()
    await db.save_pending_approval(
        run_id=run_id, action="RESCHEDULE_PRODUCTION", payload=context,
        requested_by="SYSTEM:disruption-monitor", enterprise_id=AGENT_ORCHESTRATOR_ENTERPRISE_ID,
        proposal_hash=compute_proposal_hash("RESCHEDULE_PRODUCTION", context),
    )
    return run_id


@pytest.mark.asyncio
async def test_approved_recovery_executes_and_restores_the_original_promise():
    run_id = await _make_pending_reschedule(dict(_RECOVERY_RESCHEDULE_CONTEXT))

    # Phase 16 — two distinct reads of the SAME production order happen
    # across one real approval-resolve call: revalidate_proposal reads it
    # BEFORE execution (still disrupted/late — nothing has run yet), and
    # _evaluate_reschedule_goal_satisfaction reads it AFTER (restored by
    # the mocked reschedule below). A single static return_value would
    # silently make the pre-execution read see the post-execution state,
    # which is exactly the real timing bug Phase 16's staleness check
    # (approval_proposal.py's RESCHEDULE_PRODUCTION branch) exists to
    # catch — side_effect models the real sequence instead.
    with patch("app.integrations.manufacturing_services.get_production_order", new=AsyncMock(side_effect=[
        {"id": "po-disrupted-1", "status": "RELEASED", "quantity": 500,
         "scheduledOperations": [{"scheduledEnd": "2026-12-07T10:00:00Z"}]},  # pre-execution: still late
        {"id": "po-disrupted-1", "status": "RELEASED", "quantity": 500,
         "scheduledOperations": [{"scheduledEnd": "2026-12-04T10:00:00Z"}]},  # post-execution: restored
    ])), patch(
        "app.routers.approvals.mfg.reschedule_production_order",
        return_value={"ordersProcessed": 2, "operationsScheduled": 5, "conflictsDetected": 0, "scheduleVersion": 3, "scope": "AFFECTED"},
    ):
        res = client.post("/approvals/reschedule/resolve", json={"run_id": run_id, "decision": "APPROVED"}, headers=HEADERS)

    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "COMPLETED"
    assert body["goal_satisfaction"]["satisfied"] is True
    assert body["goal_satisfaction"]["promised_date"] == "2026-12-04T10:00:00Z"
    assert body["goal_satisfaction"]["requested_date"] == "2026-12-05"


@pytest.mark.asyncio
async def test_approved_recovery_executes_but_promise_remains_violated():
    """brief §14 — never RECOVERY_SUCCESS just because the reschedule API
    call returned 200. The bottleneck reschedule here genuinely runs, but
    the real resulting schedule still misses the original promise."""
    run_id = await _make_pending_reschedule(dict(_RECOVERY_RESCHEDULE_CONTEXT))

    with patch("app.integrations.manufacturing_services.get_production_order", new=AsyncMock(return_value={
        "id": "po-disrupted-1", "status": "RELEASED", "quantity": 500,
        "scheduledOperations": [{"scheduledEnd": "2026-12-09T10:00:00Z"}],
    })), patch(
        "app.routers.approvals.mfg.reschedule_production_order",
        return_value={"ordersProcessed": 2, "operationsScheduled": 5, "conflictsDetected": 1, "scheduleVersion": 3, "scope": "AFFECTED"},
    ):
        res = client.post("/approvals/reschedule/resolve", json={"run_id": run_id, "decision": "APPROVED"}, headers=HEADERS)

    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "COMPLETED"  # the HTTP call itself succeeded
    assert body["goal_satisfaction"]["satisfied"] is False  # but the real promise is still broken


@pytest.mark.asyncio
async def test_rejecting_a_recovery_proposal_leaves_the_schedule_unchanged():
    run_id = await _make_pending_reschedule(dict(_RECOVERY_RESCHEDULE_CONTEXT))

    with patch(
        "app.routers.approvals.mfg.reschedule_production_order",
        side_effect=AssertionError("must not be called for a rejected recovery proposal"),
    ):
        res = client.post("/approvals/reschedule/resolve", json={"run_id": run_id, "decision": "REJECTED"}, headers=HEADERS)

    assert res.status_code == 200
    assert res.json() == {"resolved": True, "status": "REJECTED"}


@pytest.mark.asyncio
async def test_reschedule_execution_failure_is_recorded_honestly_not_silently_retried_or_masked():
    """Phase 16 — real gap found: a genuine failure of the committing
    reschedule call itself (scheduling-service down, a real scheduling
    conflict it raises on) was never exercised for the RESCHEDULE_
    PRODUCTION path (only create_order's execution-failure branch had
    coverage). The approval must land honestly as a failure the caller can
    see (502, not a silent 200), the real error recorded for the audit
    trail, and the approval must NOT revert to PENDING (which would let a
    retry bypass the original human decision — see mark_execution_failed's
    own reasoning)."""
    run_id = await _make_pending_reschedule(dict(_RECOVERY_RESCHEDULE_CONTEXT))

    with patch("app.approval_proposal.mfg.get_production_order", new=AsyncMock(return_value={
        "id": "po-disrupted-1", "status": "RELEASED", "scheduledOperations": [{"scheduledEnd": "2026-12-09T10:00:00Z"}],
    })), patch(
        "app.routers.approvals.mfg.reschedule_production_order",
        AsyncMock(side_effect=RuntimeError("scheduling-service unreachable")),
    ):
        res = client.post("/approvals/reschedule/resolve", json={"run_id": run_id, "decision": "APPROVED"}, headers=HEADERS)

    assert res.status_code == 502
    assert "scheduling-service unreachable" in res.json()["detail"]

    row = await db.get_approval(run_id)
    assert row["approvalStatus"] == "APPROVED"  # not reverted to PENDING — a retry must be a fresh request, never a replay
    assert "scheduling-service unreachable" in row["executionResult"]["error"]


@pytest.mark.asyncio
async def test_stale_schedule_version_blocks_execution():
    """brief §19 unit test 11 — if the referenced ProductionOrder can no
    longer even be read (e.g. deleted/replaced between proposal and
    approval), execution is blocked, not silently attempted."""
    run_id = await _make_pending_reschedule(dict(_RECOVERY_RESCHEDULE_CONTEXT))

    with patch("app.approval_proposal.mfg.get_production_order", new=AsyncMock(side_effect=Exception("not found"))), patch(
        "app.routers.approvals.mfg.reschedule_production_order",
        side_effect=AssertionError("must not be called once the proposal is stale"),
    ):
        res = client.post("/approvals/reschedule/resolve", json={"run_id": run_id, "decision": "APPROVED"}, headers=HEADERS)

    assert res.status_code == 409
    row = await db.get_approval(run_id)
    assert row["approvalStatus"] == "STALE"
