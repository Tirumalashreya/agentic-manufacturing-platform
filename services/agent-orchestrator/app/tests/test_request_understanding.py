# app/tests/test_request_understanding.py
import pytest

from app.agents.request_understanding_agent import request_understanding_agent


@pytest.mark.asyncio
async def test_understanding_agent_flags_product_request_not_financial():
    result = await request_understanding_agent(
        "Create an order for 30 pumps for Delta Manufacturing. They need a specific "
        "configuration with a higher-pressure rating and stainless-steel components. "
        "Validate the configuration before proceeding."
    )

    assert result.mentions_product_or_service is True
    assert result.mentions_financial_adjustment is False
    assert "pump" in result.goal.lower() or "configur" in result.goal.lower()


@pytest.mark.asyncio
async def test_understanding_agent_flags_genuine_financial_adjustment():
    result = await request_understanding_agent(
        "Please issue a credit memo of 5000 to our account for a billing error, "
        "not tied to any order."
    )

    assert result.mentions_financial_adjustment is True


@pytest.mark.asyncio
async def test_understanding_agent_captures_constraints_and_actions():
    result = await request_understanding_agent(
        "ABC Corp wants 20 laptops, but only ship from stock we already have — "
        "don't manufacture the shortfall. Check stock before confirming."
    )

    assert len(result.constraints) > 0 or len(result.requested_actions) > 0
