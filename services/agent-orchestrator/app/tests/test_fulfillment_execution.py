# app/tests/test_fulfillment_execution.py
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

    assert result["entry_type"] == "DIRECT_SALES"
    assert result["sales_order_id"] is not None
    assert result["fulfillment_strategy"] == "MTS"
    # BILLED once Delivery+Billing were wired in (invoice created
    # automatically after a stock reservation) — this test predated that
    # and was never re-verified live under it until now.
    assert result["status"] == "BILLED"
    assert "Reserved from stock" in result["response"]
    assert "invoiced" in result["response"]


@pytest.mark.asyncio
async def test_configurable_product_order_requires_configuration():
    # Laptop - Standard is configurable=True, so this should resolve to
    # CTO regardless of stock on hand (matches fulfillment_agent's own
    # stated preference, confirmed in earlier live testing).
    result = await graph.ainvoke({
        "user_message": "Zenith Enterprises wants to order 3 Laptop - Standard units now."
    })

    assert result["entry_type"] == "DIRECT_SALES"
    assert result["fulfillment_strategy"] == "CTO"
    assert result["status"] == "IN_PRODUCTION"
    # "requires configuration" was a hardcoded literal from before
    # Configuration Agent existed — it now generates real notes instead,
    # so check for the actual current signal: a Production Order that
    # captured a configuration_options result (empty list is still valid —
    # it means the customer stated no specific options).
    assert "Production Order" in result["response"]
    assert "configuration_options" in result
    assert isinstance(result["configuration_options"], list)


@pytest.mark.asyncio
async def test_no_stock_third_party_is_sourced_from_vendor():
    # Webcam HD: not configurable, can_produce=False — a request beyond
    # real stock forces THIRD_PARTY, which now has a real execution path
    # via ProductVendors (two vendors seeded for this product).
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

    assert result["entry_type"] == "DIRECT_SALES"
    assert result["fulfillment_strategy"] == "THIRD_PARTY"
    assert result["status"] == "SOURCING"
    assert "Trading Order" in result["response"]
    assert "Sourced from vendor" in result["response"]


@pytest.mark.asyncio
async def test_third_party_with_no_vendor_data_is_pending_manual_action():
    # Every real can_produce=False product in the catalog now has vendor
    # data, so this exercises the genuine no-vendor fallback directly
    # against the node rather than through the live graph.
    from app.graph import third_party_node

    state = {
        "product_id": "P999_NO_VENDOR",
        "product_name": "Nonexistent Product",
        "fulfillment_strategy": "THIRD_PARTY",
        "fulfillment_to_produce": 10,
        "sales_order_id": "SO_TEST",
        "lead_time_days": 20,
        "response": "",
    }
    result = await third_party_node(state)

    assert result["status"] == "PENDING_MANUAL_ACTION"
    assert "no vendor is on file" in result["response"]
