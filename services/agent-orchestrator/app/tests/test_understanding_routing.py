# app/tests/test_understanding_routing.py
"""
Deterministic (no live Groq call) tests for the Phase 1 request-
understanding routing: understanding_router, unclear_node, and
unsupported_node. intent_agent and request_understanding_agent are both
mocked — these tests verify the WIRING is correct (right node reached,
right fields carried, downstream nodes not invoked when they shouldn't
be), not the LLM's judgment quality, which needs live tests instead.
"""
from unittest.mock import patch

import pytest

from app.agents.intent_agent import IntentResult
from app.graph import graph, understanding_router
from app.schemas.context import ContextResult
from app.schemas.process import ProcessResult
from app.schemas.understanding import EntityReference, RequestedAction, RequestUnderstanding


def _intent(**overrides):
    base = dict(
        intent="create_order",
        customer=None,
        product=None,
        quantity=None,
        requested_deadline=None,
        needs_clarification=False,
        clarification_question=None,
    )
    base.update(overrides)
    return IntentResult(**base)


def _understanding(**overrides):
    base = dict(
        goal="test goal",
        constraints=[],
        requested_actions=[],
        mentions_product_or_service=False,
        mentions_financial_adjustment=False,
        is_supported=True,
        reasoning="test",
    )
    base.update(overrides)
    return RequestUnderstanding(**base)


def test_understanding_router_routes_unsupported():
    assert understanding_router({"is_supported": False}) == "unsupported"


def test_understanding_router_routes_supported_to_context():
    assert understanding_router({"is_supported": True}) == "context"


@pytest.mark.asyncio
async def test_unsupported_request_short_circuits_before_context_and_process():
    # context_agent/process_agent raising if called is the proof they
    # never run for an unsupported request — not just that the response
    # looks right, but that the graph actually took the short-circuit
    # path and didn't waste (or risk) a real ERP lookup / classification
    # call on something it already knows it can't handle.
    with patch("app.graph.intent_agent", return_value=_intent()), patch(
        "app.graph.request_understanding_agent",
        return_value=_understanding(
            goal="Arrange financing for this customer",
            is_supported=False,
        ),
    ), patch("app.graph.context_agent", side_effect=AssertionError("context_agent should not be called")), \
       patch("app.graph.process_agent", side_effect=AssertionError("process_agent should not be called")):
        result = await graph.ainvoke({
            "user_message": "Can you arrange financing or a payment plan for this customer?"
        })

    assert result["status"] == "UNSUPPORTED"
    assert "financing" in result["response"].lower()
    assert result.get("entry_type") is None


@pytest.mark.asyncio
async def test_supported_request_reaches_context_not_unsupported():
    # Fully mocked, no live Groq call anywhere in this test — proves
    # is_supported=True routes to "context" (not "unsupported") by
    # making context_agent raise a distinctive error the instant it's
    # reached, rather than by running the real downstream pipeline.
    with patch("app.graph.intent_agent", return_value=_intent()), patch(
        "app.graph.request_understanding_agent",
        return_value=_understanding(is_supported=True, mentions_product_or_service=True),
    ), patch("app.graph.context_agent", side_effect=RuntimeError("reached context")) as mock_context:
        with pytest.raises(RuntimeError, match="reached context"):
            await graph.ainvoke({"user_message": "anything"})

    mock_context.assert_called_once()


@pytest.mark.asyncio
async def test_needs_clarification_still_short_circuits_before_understanding():
    # intent_agent's own clarification path (pre-existing behavior) must
    # still take priority — understanding_agent should never even be
    # called if intent extraction already couldn't proceed.
    with patch(
        "app.graph.intent_agent",
        return_value=_intent(needs_clarification=True, clarification_question="Which product?"),
    ), patch(
        "app.graph.request_understanding_agent",
        side_effect=AssertionError("request_understanding_agent should not be called"),
    ):
        result = await graph.ainvoke({"user_message": "I need something."})

    assert result["status"] == "NEEDS_CLARIFICATION"
    assert result["clarification_question"] == "Which product?"


@pytest.mark.asyncio
async def test_references_flow_through_to_final_state():
    # Phase 2 step 1 plumbing check — proves EntityReference objects
    # survive the round trip into SalesState as plain dicts, without
    # needing a live model call to judge whether the extraction itself
    # was any good (that's test_reference_extraction.py's job). Routed
    # through unsupported=True so the graph reaches a clean terminal
    # state without needing context/process mocked too.
    references = [
        EntityReference(entity_type="customer", identifier_type="explicit_name", identifier="Delta Manufacturing"),
        EntityReference(entity_type="sales_order", identifier_type="relative", identifier="their latest order"),
    ]
    with patch("app.graph.intent_agent", return_value=_intent()), patch(
        "app.graph.request_understanding_agent",
        return_value=_understanding(is_supported=False, references=references),
    ):
        result = await graph.ainvoke({"user_message": "anything"})

    assert result["request_references"] == [r.model_dump() for r in references]


@pytest.mark.asyncio
async def test_reference_resolution_runs_between_understanding_and_context():
    # Fully mocked path (intent, understanding, context, process) that
    # still reaches a clean terminal node (entry_router's existing
    # "unclear" override — see FINANCIAL + mentions_product_or_service),
    # so this can inspect the actual final state instead of catching an
    # exception. Proves reference_resolution_node really runs in the
    # live graph wiring and resolves a real record, not just that the
    # standalone resolve_reference() function works in isolation.
    references = [EntityReference(entity_type="customer", identifier_type="explicit_name", identifier="ABC Corp")]
    with patch("app.graph.intent_agent", return_value=_intent()), patch(
        "app.graph.request_understanding_agent",
        return_value=_understanding(
            is_supported=True,
            mentions_product_or_service=True,
            mentions_financial_adjustment=False,
            references=references,
        ),
    ), patch("app.graph.context_agent", return_value=ContextResult()), patch(
        "app.graph.process_agent",
        return_value=ProcessResult(
            entry_type="FINANCIAL", process="FINANCIAL_ADJUSTMENT",
            starting_stage="Financial Adjustment", reasoning="test",
        ),
    ):
        result = await graph.ainvoke({"user_message": "anything"})

    assert result["status"] == "NEEDS_CLARIFICATION"  # unclear_node's shape
    assert len(result["resolved_references"]) == 1
    resolved = result["resolved_references"][0]
    assert resolved["status"] == "RESOLVED"
    assert resolved["resolved_record"]["customer_id"] == "C001"


@pytest.mark.asyncio
async def test_action_plan_flows_through_to_final_state():
    # Phase 2 step 2.3 plumbing check — proves a structured, dependent
    # action_plan survives the round trip into SalesState as plain dicts.
    # Does NOT test whether the LLM extracts a good plan (that's
    # test_action_plan_extraction.py's job, run live) — routed through
    # unsupported=True so this reaches a clean terminal state with only
    # intent/understanding mocked.
    plan = [
        RequestedAction(action="check_credit", depends_on=[]),
        RequestedAction(action="create_order", depends_on=["check_credit"]),
    ]
    with patch("app.graph.intent_agent", return_value=_intent()), patch(
        "app.graph.request_understanding_agent",
        return_value=_understanding(is_supported=False, action_plan=plan),
    ):
        result = await graph.ainvoke({"user_message": "anything"})

    assert result["request_action_plan"] == [a.model_dump() for a in plan]
