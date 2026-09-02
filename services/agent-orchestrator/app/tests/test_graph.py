import pytest

from app.graph import graph


@pytest.mark.asyncio
async def test_intent_graph():
    result = await graph.ainvoke({
        "user_message": "ABC needs 100 laptops by next month. Give them a quote."
    })

    assert result["customer"] == "ABC"
    assert result["quantity"] == 100
    assert result["product"] == "laptops"
    assert result["intent"] == "request_quote"