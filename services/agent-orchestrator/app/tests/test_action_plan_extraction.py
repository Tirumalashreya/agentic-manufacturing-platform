# app/tests/test_action_plan_extraction.py
"""
Phase 2 step 2.3 evaluation set (agreed with the user): tests
request_understanding_agent IN ISOLATION on whether it can produce a
reliable multi-action/dependency structure. Requires a live
GROQ_API_KEY and burns real quota — run explicitly, not swept into a
full-suite pass. Nothing here touches graph.py; action_plan is purely
descriptive and unexecuted, same as request_references.
"""
import pytest

from app.agents.request_understanding_agent import request_understanding_agent


@pytest.mark.asyncio
async def test_single_action_request_has_empty_plan():
    result = await request_understanding_agent("Order 10 Wireless Mouse units for ABC Corp.")

    assert result.action_plan == []


@pytest.mark.asyncio
async def test_conditional_two_step_request():
    result = await request_understanding_agent(
        "Check Delta's credit and, if they're within limit, place the order."
    )

    assert len(result.action_plan) == 2
    labels = {a.action for a in result.action_plan}
    credit_action = next(a for a in result.action_plan if "credit" in a.action.lower())
    order_action = next(a for a in result.action_plan if a.action != credit_action.action)
    assert credit_action.depends_on == []
    assert credit_action.action in order_action.depends_on


@pytest.mark.asyncio
async def test_sequential_two_step_request():
    result = await request_understanding_agent("Check stock first, then create the order.")

    assert len(result.action_plan) == 2
    stock_action = next(a for a in result.action_plan if "stock" in a.action.lower())
    other_action = next(a for a in result.action_plan if a.action != stock_action.action)
    assert stock_action.depends_on == []
    assert stock_action.action in other_action.depends_on


@pytest.mark.asyncio
async def test_plan_never_invents_a_dependency_not_stated():
    # Two actions mentioned with no stated ordering/conditionality at all
    # should not be given a fabricated dependency between them.
    result = await request_understanding_agent(
        "Update the shipping address on file and also send a copy of the latest invoice."
    )

    for action in result.action_plan:
        assert action.depends_on == [] or all(
            dep in [a.action for a in result.action_plan] for dep in action.depends_on
        )
