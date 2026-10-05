# app/tests/test_credit_check_live.py
import pytest

from app.graph import graph


@pytest.mark.asyncio
async def test_order_within_credit_limit_proceeds_to_fulfillment():
    # check_credit() sums every confirmed Sales Order a customer has ever
    # had, forever, with no netting against payment — and mock_erp.xlsx is
    # shared, ever-growing state across this whole session's live tests.
    # Any hardcoded "customer X has headroom" assumption eventually goes
    # stale (this exact test already swapped Nova -> Coastal once for this
    # reason, and by the time Project's tests were added, Coastal itself
    # had also drifted past its limit). Compute real current headroom
    # instead of hardcoding a customer/quantity pair that will just break
    # again next session.
    from app.tools.credit_tools import check_credit
    from app.tools.customer_tools import get_customer
    from app.tools.product_tools import get_product

    customer = get_customer("Coastal Electronics Group")
    product = get_product("Wireless Mouse")
    exposure = check_credit(customer["customer_id"], customer["credit_limit"], 0)
    headroom = exposure["credit_limit"] - exposure["existing_exposure"]
    quantity = max(1, int((headroom * 0.1) // product["price"]))
    assert quantity * product["price"] < headroom, (
        "test setup assumption broken: Coastal Electronics Group has no real credit headroom left"
    )

    result = await graph.ainvoke({
        "user_message": f"Coastal Electronics Group wants to order {quantity} wireless mice now."
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
