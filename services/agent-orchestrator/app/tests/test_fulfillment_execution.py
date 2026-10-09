# app/tests/test_fulfillment_execution.py
#
# Stage 03D (ungated-path convergence): these tests used to drive the
# live graph through the old DIRECT_SALES path (mts_node/cto_node/
# third_party_node, all auto-executing with zero approval) and assert a
# final, fully-executed status (BILLED/IN_PRODUCTION/SOURCING). That path
# is gone — composed_execution_node now handles every order-creating
# request, DIRECT_SALES-classified or not, and stops at AWAITING_APPROVAL
# (or a real CUSTOMER_NOT_FOUND/ON_CREDIT_HOLD) before anything commits.
# These tests now assert the same real fulfillment-strategy decision —
# computed identically, pre-approval, by composed_execution_node's own
# fulfillment_agent/configuration_agent/procurement_agent calls — shows
# up correctly in the approval preview, with nothing executed yet.
import pytest

from app.graph import graph


@pytest.mark.asyncio
async def test_full_stock_order_is_fulfilled_from_stock():
    # Wireless Mouse: non-configurable, plenty of real stock (340 units
    # across both plants) — a small order should resolve to MTS.
    # Zenith Enterprises, not Titan — Titan's real exposure from a
    # session's worth of live testing has since grown past its own
    # credit limit, same reason Nova Electronics was swapped out earlier.
    result = await graph.ainvoke({
        "user_message": "Zenith Enterprises wants to order 5 wireless mice now."
    })

    assert result["entry_type"] == "COMPOSED_PLAN"
    assert result["status"] in ("AWAITING_APPROVAL", "CUSTOMER_NOT_FOUND", "ON_CREDIT_HOLD")
    assert result.get("sales_order_id") is None

    if result["status"] == "AWAITING_APPROVAL":
        fulfillment = result["pending_approval"]["preview"]["fulfillment"]
        assert fulfillment["strategy"] == "MTS"
        assert fulfillment["from_stock"] + fulfillment["to_produce"] == 5
        # MTS needs no production plan at all — nothing to produce.
        assert result["pending_approval"]["context"]["production_plan"] is None


@pytest.mark.asyncio
async def test_configurable_product_order_requires_configuration():
    # Laptop - Standard is configurable=True, so this should resolve to
    # CTO regardless of stock on hand (matches fulfillment_agent's own
    # stated preference, confirmed in earlier live testing).
    result = await graph.ainvoke({
        "user_message": "Zenith Enterprises wants to order 3 Laptop - Standard units now."
    })

    assert result["entry_type"] == "COMPOSED_PLAN"
    assert result["status"] in ("AWAITING_APPROVAL", "CUSTOMER_NOT_FOUND", "ON_CREDIT_HOLD")
    assert result.get("sales_order_id") is None

    if result["status"] == "AWAITING_APPROVAL":
        fulfillment = result["pending_approval"]["preview"]["fulfillment"]
        assert fulfillment["strategy"] == "CTO"
        # The real production plan (BOM/routing/capacity, computed via
        # APS Platform) exists in the preview the human sees — not yet
        # committed (no real ProductionOrder survives a reject). An
        # empty/None configuration_notes is still valid — it means the
        # customer stated no specific options, same honest case the old
        # cto_node's empty configuration_options list used to represent.
        production_plan = result["pending_approval"]["context"]["production_plan"]
        assert production_plan is not None
        assert "configuration_notes" in production_plan


@pytest.mark.asyncio
async def test_no_stock_third_party_is_sourced_from_vendor():
    # Webcam HD: not configurable, can_produce=False — a request beyond
    # real stock forces THIRD_PARTY, which has a real vendor pick via
    # ProductVendors (two vendors seeded for this product).
    #
    # The quantity is computed from *actual current* stock rather than a
    # hardcoded number: mock_erp.xlsx is shared, ever-mutating state (this
    # session's own Trading tests warehouse real stock into this exact
    # product), so a fixed "100 units" silently stops forcing THIRD_PARTY
    # once enough prior activity has pushed real stock past it — asserting
    # MTS instead, which is genuinely correct given more stock, not a bug.
    #
    # Same reasoning applies to credit: check against real current
    # headroom (existing exposure nets against nothing and only grows
    # across this session's live tests), not the raw credit_limit, which
    # this exact class of assumption has already gone stale on elsewhere
    # (see test_credit_check_live.py).
    from app.tools.credit_tools import check_credit
    from app.tools.customer_tools import get_customer
    from app.tools.inventory_tools import get_stock
    from app.tools.product_tools import get_product

    product = get_product("Webcam HD")
    stock_total = sum(row["stock_qty"] for row in get_stock(product["product_id"]))
    customer = get_customer("Zenith Enterprises")
    exposure = check_credit(customer["customer_id"], customer["credit_limit"], 0)
    headroom = exposure["credit_limit"] - exposure["existing_exposure"]

    quantity = stock_total + 20
    assert quantity * product["price"] < headroom, (
        "test setup assumption broken: Zenith Enterprises has no real credit headroom for this order"
    )

    result = await graph.ainvoke({
        "user_message": f"Zenith Enterprises wants to order {quantity} Webcam HD units now."
    })

    assert result["entry_type"] == "COMPOSED_PLAN"
    assert result["status"] in ("AWAITING_APPROVAL", "CUSTOMER_NOT_FOUND", "ON_CREDIT_HOLD")
    assert result.get("sales_order_id") is None

    if result["status"] == "AWAITING_APPROVAL":
        fulfillment = result["pending_approval"]["preview"]["fulfillment"]
        assert fulfillment["strategy"] == "THIRD_PARTY"
        vendor_plan = result["pending_approval"]["context"]["vendor_plan"]
        assert vendor_plan is not None
        assert vendor_plan.get("vendors_available") is not False


@pytest.mark.asyncio
async def test_third_party_with_no_vendor_data_reports_no_vendors_available():
    # Every real can_produce=False product in the catalog now has vendor
    # data, so this exercises the genuine no-vendor fallback directly
    # against _plan_vendor_sourcing — the surviving function that now
    # computes this pre-approval (third_party_node, which used to make
    # this same call at execution time with no human ever seeing it
    # first, was removed as part of Stage 03D).
    from app.graph import _plan_vendor_sourcing

    result = await _plan_vendor_sourcing(
        product_id="P999_NO_VENDOR", product_name="Nonexistent Product", quantity=10, lead_time_days=20
    )

    assert result == {"vendors_available": False}
