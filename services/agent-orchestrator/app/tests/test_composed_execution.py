# app/tests/test_composed_execution.py
"""
Fully deterministic — intent_agent/request_understanding_agent/
context_agent are all mocked (no live Groq call), but composed_execution_
node itself runs for real against the real ERP tools, same as
test_plan_executor.py but exercised through the actual compiled graph
wiring (composed_execution_router + the node), not just the standalone
execute_action_plan() function.
"""
from unittest.mock import patch

import pytest

from app.agents.intent_agent import IntentResult
from app.graph import graph
from app.schemas.context import ContextResult
from app.schemas.understanding import RequestedAction, RequestUnderstanding


def _intent(**overrides):
    base = dict(
        intent="create_order", customer="Northgate Traders", product="Wireless Mouse",
        quantity=5, requested_deadline=None, needs_clarification=False, clarification_question=None,
    )
    base.update(overrides)
    return IntentResult(**base)


def _understanding(action_plan, **overrides):
    base = dict(
        goal="test goal", constraints=[], requested_actions=[],
        mentions_product_or_service=True, mentions_financial_adjustment=False,
        is_supported=True, references=[], action_plan=action_plan, reasoning="test",
    )
    base.update(overrides)
    return RequestUnderstanding(**base)


def _context(**overrides):
    base = dict(
        customer_id="C018", customer_name="Northgate Traders", customer_exists=True,
        # Large enough to stay valid regardless of how much live/manual
        # testing accumulates against C018's real exposure over time (a
        # real bug found live multiple times this session: a fixed
        # headroom assumption drifting stale as the shared mock_erp.xlsx
        # keeps accruing real orders from demo/manual testing).
        customer_active=True, customer_credit_limit=100_000_000.0,
        product_id="P011", product_name="Wireless Mouse", product_valid=True, price=800.0,
    )
    base.update(overrides)
    return ContextResult(**base)


@pytest.mark.asyncio
async def test_qualifying_plan_reaches_composed_execution_and_awaits_approval():
    # create_order is gated (plan_executor.GATE_BEFORE) — even with
    # credit passing, no order gets created here. That only happens via
    # a separate approval call (see test_approvals_sales_order.py).
    plan = [
        RequestedAction(action="check_credit", depends_on=[]),
        RequestedAction(action="create_order", depends_on=["check_credit"]),
    ]
    with patch("app.graph.intent_agent", return_value=_intent()), patch(
        "app.graph.request_understanding_agent", return_value=_understanding(plan)
    ), patch("app.graph.context_agent", return_value=_context()), patch(
        "app.graph.process_agent", side_effect=AssertionError("process_agent should not be called")
    ):
        result = await graph.ainvoke({"user_message": "anything"})

    assert result["entry_type"] == "COMPOSED_PLAN"
    assert result["status"] == "AWAITING_APPROVAL"
    assert result["credit_checked"] is True
    assert result["credit_within_limit"] is True
    assert result.get("sales_order_id") is None
    assert result["pending_approval"]["action"] == "create_order"
    assert result["pending_approval"]["preview"]["customer_name"] == "Northgate Traders"
    assert result["pending_approval"]["preview"]["credit_within_limit"] is True
    assert result["pending_approval"]["preview"]["estimated_value"] == 5 * 800.0


@pytest.mark.asyncio
async def test_paraphrased_request_with_unknown_action_still_gates_for_approval():
    # Regression test for a real bug found live: "check everything and
    # prepare the order for approval" made request_understanding_agent
    # extract an unrecognized label ("check_everything") alongside
    # create_order's own alias. Under the old router
    # (len(plan) >= 2 AND every action known), that one unrecognized
    # label failed the whole plan and the request fell through to the
    # old, ungated direct_sales path — silently creating the order with
    # NO human approval step. This asserts a plan shaped exactly like
    # that now still reaches the approval gate, with check_credit having
    # actually run (not skipped as an unmet dependency of a label that
    # was never in the plan at all).
    plan = [
        RequestedAction(action="check_everything", depends_on=[]),
        RequestedAction(action="prepare_order", depends_on=["check_everything"]),
    ]
    with patch("app.graph.intent_agent", return_value=_intent()), patch(
        "app.graph.request_understanding_agent", return_value=_understanding(plan)
    ), patch("app.graph.context_agent", return_value=_context()), patch(
        "app.graph.process_agent", side_effect=AssertionError("process_agent should not be called")
    ):
        result = await graph.ainvoke({"user_message": "anything"})

    assert result["entry_type"] == "COMPOSED_PLAN"
    assert result["status"] == "AWAITING_APPROVAL"
    assert result["credit_checked"] is True
    assert result["credit_within_limit"] is True
    assert result["stock_checked"] is True
    assert result.get("sales_order_id") is None
    assert result["pending_approval"]["action"] == "create_order"


@pytest.mark.asyncio
async def test_single_create_order_action_alone_still_gates_for_approval():
    # Even the smallest possible order-creating plan — just create_order,
    # no explicit check_credit/check_stock at all — must still reach the
    # approval gate with credit/stock forced to run first.
    plan = [RequestedAction(action="create_order", depends_on=[])]
    with patch("app.graph.intent_agent", return_value=_intent()), patch(
        "app.graph.request_understanding_agent", return_value=_understanding(plan)
    ), patch("app.graph.context_agent", return_value=_context()), patch(
        "app.graph.process_agent", side_effect=AssertionError("process_agent should not be called")
    ):
        result = await graph.ainvoke({"user_message": "anything"})

    assert result["status"] == "AWAITING_APPROVAL"
    assert result["credit_checked"] is True
    assert result["stock_checked"] is True
    assert result["pending_approval"]["action"] == "create_order"


@pytest.mark.asyncio
async def test_three_action_plan_check_stock_field_survives_state_merge():
    # Regression test for a real bug found live: stock_checked/
    # stock_sufficient/stock_total were computed correctly in Python but
    # silently vanished from every API response because LangGraph drops
    # any key a node returns that isn't declared in SalesState (see
    # app/schemas/state.py) — this asserts they land at the TOP LEVEL of
    # the result, not just nested inside pending_approval.preview.
    plan = [
        RequestedAction(action="check_credit", depends_on=[]),
        RequestedAction(action="check_stock", depends_on=[]),
        RequestedAction(action="prepare_order", depends_on=["check_credit", "check_stock"]),
    ]
    with patch("app.graph.intent_agent", return_value=_intent()), patch(
        "app.graph.request_understanding_agent", return_value=_understanding(plan)
    ), patch("app.graph.context_agent", return_value=_context()):
        result = await graph.ainvoke({"user_message": "anything"})

    assert result["status"] == "AWAITING_APPROVAL"
    assert result["stock_checked"] is True
    assert result["stock_sufficient"] is True
    assert result["stock_total"] is not None
    assert result["pending_approval"]["action"] == "create_order"


@pytest.mark.asyncio
async def test_qualifying_plan_gates_create_order_on_credit_failure():
    plan = [
        RequestedAction(action="check_credit", depends_on=[]),
        RequestedAction(action="create_order", depends_on=["check_credit"]),
    ]
    with patch("app.graph.intent_agent", return_value=_intent()), patch(
        "app.graph.request_understanding_agent", return_value=_understanding(plan)
    ), patch("app.graph.context_agent", return_value=_context(customer_credit_limit=0.0)):
        result = await graph.ainvoke({"user_message": "anything"})

    assert result["entry_type"] == "COMPOSED_PLAN"
    # Phase 4: a gated credit failure gets the same meaningful status
    # credit_hold_node already gives a normal DIRECT_SALES order, not a
    # generic "PARTIAL".
    assert result["status"] == "ON_CREDIT_HOLD"
    assert result["credit_within_limit"] is False
    assert result.get("sales_order_id") is None


@pytest.mark.asyncio
async def test_qualifying_plan_reports_unknown_customer_distinctly_from_credit_hold():
    # Regression test for a real bug found live: an unresolvable customer
    # (no ERP record, so no credit limit to check against) made
    # check_credit() return checked=False — a check that was never
    # performed, not one that failed — but composed_execution_node used
    # to report that identically to a real "checked, and over the limit"
    # failure, surfacing ON_CREDIT_HOLD with None-filled exposure figures
    # instead of the honest "no such customer" reason.
    plan = [
        RequestedAction(action="check_credit", depends_on=[]),
        RequestedAction(action="create_order", depends_on=["check_credit"]),
    ]
    unknown_customer_context = _context(
        customer_id=None, customer_name=None, customer_exists=False,
        customer_active=False, customer_credit_limit=None,
    )
    with patch("app.graph.intent_agent", return_value=_intent()), patch(
        "app.graph.request_understanding_agent", return_value=_understanding(plan)
    ), patch("app.graph.context_agent", return_value=unknown_customer_context):
        result = await graph.ainvoke({"user_message": "anything"})

    assert result["status"] == "CUSTOMER_NOT_FOUND"
    assert result["status"] != "ON_CREDIT_HOLD"
    assert result["credit_checked"] is False
    assert result.get("sales_order_id") is None
    assert "don't have this customer on file" in result["response"]


@pytest.mark.asyncio
async def test_single_action_plan_with_create_order_intent_still_gates_for_approval():
    # Real bug found live (agreed with the user): a genuine create_order
    # request whose action_plan didn't happen to contain a recognized
    # create_order-shaped label ("prepare_units" — request_understanding_agent's
    # own paraphrase, not one of plan_executor's known aliases) used to
    # fall through to process_agent -> entry_router -> direct_sales_node,
    # which creates the real Sales Order as its very first action, before
    # credit is even checked and with NO approval gate at all — reproduced
    # live, a real order got created with zero human review. Fixed:
    # intent_agent's own "create_order" classification (a small, controlled
    # enum, not free text) is now trusted directly by
    # plan_targets_order_creation, so ANY create_order-intent request
    # reaches the gate regardless of the action_plan's exact shape — this
    # was previously named "...still_routes_to_normal_process_agent" and
    # asserted the opposite (that this case reached the ungated path);
    # that was the bug, not the correct behavior.
    plan = [RequestedAction(action="check_credit", depends_on=[])]
    with patch("app.graph.intent_agent", return_value=_intent()), patch(
        "app.graph.request_understanding_agent", return_value=_understanding(plan)
    ), patch("app.graph.context_agent", return_value=_context()), patch(
        "app.graph.process_agent", side_effect=AssertionError("process_agent should not be called")
    ):
        result = await graph.ainvoke({"user_message": "anything"})

    assert result["status"] == "AWAITING_APPROVAL"
    assert result["credit_checked"] is True
    assert result.get("sales_order_id") is None
    assert result["pending_approval"]["action"] == "create_order"


@pytest.mark.asyncio
async def test_plan_with_unsupported_action_and_create_order_intent_still_gates_for_approval():
    # Same real bug, different trigger shape — an entirely unrecognized
    # action label ("arrange_financing") alongside check_credit. Intent
    # still says create_order, so this must still gate, not fall through.
    plan = [
        RequestedAction(action="arrange_financing", depends_on=[]),
        RequestedAction(action="check_credit", depends_on=[]),
    ]
    with patch("app.graph.intent_agent", return_value=_intent()), patch(
        "app.graph.request_understanding_agent", return_value=_understanding(plan)
    ), patch("app.graph.context_agent", return_value=_context()), patch(
        "app.graph.process_agent", side_effect=AssertionError("process_agent should not be called")
    ):
        result = await graph.ainvoke({"user_message": "anything"})

    assert result["status"] == "AWAITING_APPROVAL"
    assert result.get("sales_order_id") is None
    assert result["pending_approval"]["action"] == "create_order"


@pytest.mark.asyncio
async def test_empty_action_plan_with_create_order_intent_still_gates_for_approval():
    # The bare "order 10 mice" case — request_understanding_agent's own
    # documented convention leaves action_plan empty for a single ordinary
    # action. Must still gate on intent alone; this is the single most
    # common real phrasing, so this is the most important case to cover.
    with patch("app.graph.intent_agent", return_value=_intent()), patch(
        "app.graph.request_understanding_agent", return_value=_understanding([])
    ), patch("app.graph.context_agent", return_value=_context()), patch(
        "app.graph.process_agent", side_effect=AssertionError("process_agent should not be called")
    ):
        result = await graph.ainvoke({"user_message": "anything"})

    assert result["status"] == "AWAITING_APPROVAL"
    assert result.get("sales_order_id") is None
    assert result["pending_approval"]["action"] == "create_order"


@pytest.mark.asyncio
async def test_non_create_order_intent_with_empty_plan_still_routes_to_process_agent():
    # The real, remaining legitimate use of process_agent for entry_type
    # classification: an intent that genuinely isn't create_order (e.g. a
    # return, a service request) must still reach it normally — the fix
    # above only intercepts create_order intent, not every request.
    with patch("app.graph.intent_agent", return_value=_intent(intent="service_request")), patch(
        "app.graph.request_understanding_agent", return_value=_understanding([])
    ), patch("app.graph.context_agent", return_value=_context()), patch(
        "app.graph.process_agent", side_effect=RuntimeError("reached process_agent")
    ):
        with pytest.raises(RuntimeError, match="reached process_agent"):
            await graph.ainvoke({"user_message": "anything"})
