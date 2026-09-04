# app/tests/test_credit_check_live.py
import pytest

from app.graph import graph


@pytest.mark.asyncio
async def test_order_within_credit_limit_proceeds_to_fulfillment():
    # Coastal Electronics Group (C020) has a real credit_limit of
    # 1,000,000 — a small mouse order should sail through credit check to
    # fulfillment. (Nova Electronics was used here before, but its
    # exposure from this session's extensive live testing has since grown
    # past its own limit — swapped to a customer with real headroom.)
    result = await graph.ainvoke({
        "user_message": "Coastal Electronics Group wants to order 5 wireless mice now."
    })

    assert result["entry_type"] == "DIRECT_SALES"
    assert result["credit_checked"] is True
    assert result["credit_within_limit"] is True
    assert result["fulfillment_strategy"] is not None
    assert result["status"] != "ON_CREDIT_HOLD"


@pytest.mark.asyncio
async def test_order_over_credit_limit_is_held():
    # XYZ Industries (C002) has a real credit_limit of 50,000 — one
    # Laptop - Gaming at 95,000 blows straight past it, so this should
    # stop at credit hold and never reach fulfillment.
    result = await graph.ainvoke({
        "user_message": "XYZ Industries wants to order 1 Laptop - Gaming now."
    })

    assert result["entry_type"] == "DIRECT_SALES"
    assert result["credit_checked"] is True
    assert result["credit_within_limit"] is False
    assert result["status"] == "ON_CREDIT_HOLD"
    assert "fulfillment_strategy" not in result or result.get("fulfillment_strategy") is None
