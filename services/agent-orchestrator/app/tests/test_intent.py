# app/tests/test_intent.py
import pytest

from app.agents.intent_agent import intent_agent


@pytest.mark.asyncio
async def test_intent_agent():
    result = await intent_agent(
        "ABC needs 100 laptops by next month. Give them a quote."
    )

    assert result.customer == "ABC"
    assert result.quantity == 100
    assert result.product == "laptops"
    assert result.intent == "request_quote"