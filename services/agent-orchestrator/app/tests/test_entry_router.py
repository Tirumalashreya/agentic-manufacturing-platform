# app/tests/test_entry_router.py
import pytest

from app.graph import graph


@pytest.mark.asyncio
async def test_request_quote_routes_to_pre_sales():
    result = await graph.ainvoke({
        "user_message": "ABC needs 100 laptops by next month. Give them a quote."
    })

    assert result["entry_type"] == "PRE_SALES"
    assert result["status"] == "COMPLETED"
    assert result["quoted_price"] is not None
    assert result["quotation_total"] is not None


@pytest.mark.asyncio
async def test_create_order_routes_to_direct_sales():
    # Coastal Electronics Group has a real credit_limit of 1,000,000 — a
    # small order keeps this test isolated from credit-hold behavior,
    # which has its own dedicated tests.
    result = await graph.ainvoke({
        "user_message": "Coastal Electronics Group wants to order 5 laptops now."
    })

    assert result["entry_type"] == "DIRECT_SALES"
    assert result["sales_order_id"] is not None
    assert result["sales_order_status"] == "CONFIRMED"
    assert result["credit_within_limit"] is True
    assert result["fulfillment_strategy"] in ("MTS", "MTO", "CTO", "THIRD_PARTY", "INTERCOMPANY", "HYBRID")
    assert result["fulfillment_from_stock"] + result["fulfillment_to_produce"] == 5
    assert result["status"] in ("FULFILLED", "BILLED", "IN_PRODUCTION", "PARTIALLY_IN_PRODUCTION", "PENDING_MANUAL_ACTION")


@pytest.mark.asyncio
async def test_create_order_for_unregistered_customer_is_rejected():
    result = await graph.ainvoke({
        "user_message": "Some Unregistered Company wants to order 100 laptops now."
    })

    assert result["entry_type"] == "DIRECT_SALES"
    assert result["status"] == "REJECTED"
    assert result["sales_order_id"] is None


@pytest.mark.asyncio
async def test_return_is_processed_by_post_sales():
    # Reference a real Sales Order — the old "SO123" was always fake, and
    # the reference-validation hardening built later in this session now
    # correctly rejects a fake order rather than silently accepting it.
    from app.tools.sales_tools import create_sales_order

    order = create_sales_order(
        customer_id="C001",
        customer_name="ABC Corp",
        customer_active=True,
        product_id="P001",
        product_name="Laptop - Standard",
        quantity=5,
        unit_price=50000.0,
        requested_deadline=None,
    )

    result = await graph.ainvoke({
        "user_message": f"ABC wants to return 5 laptops from order {order['sales_order_id']}."
    })

    assert result["entry_type"] == "POST_SALES"
    # A return goes to PENDING_INSPECTION now, not immediately COMPLETED —
    # built later in this session (inspection has to happen before
    # inventory/credit is actually granted).
    assert result["status"] == "PENDING_INSPECTION"
    assert result["return_id"] is not None
    assert result["return_id"].startswith("RET")


@pytest.mark.asyncio
async def test_subscription_renewal_is_processed():
    # Every entry_type category — Service, Subscription, Project, Export,
    # Consignment, and Financial — got a real workflow this session.
    #
    # RENEWAL now correctly requires a real existing ACTIVE subscription to
    # act on (it extends renewal_date rather than creating a duplicate row)
    # — so, same pattern as the return test above referencing a real Sales
    # Order, pre-create the subscription being renewed instead of assuming
    # one already exists.
    from app.tools.subscription_tools import create_subscription

    existing = create_subscription(
        customer_id="C001",
        customer_name="ABC Corp",
        plan_id="PLN004",
        plan_name="Annual Software Subscription",
        price=120000,
        billing_frequency="ANNUAL",
        action="NEW",
    )

    result = await graph.ainvoke({
        "user_message": "ABC wants to renew their annual software subscription for 1 year."
    })

    assert result["entry_type"] == "SUBSCRIPTION"
    assert result["subscription_id"] == existing["subscription_id"]
    assert result["status"] == "ACTIVE"


@pytest.mark.asyncio
async def test_project_award_is_processed():
    result = await graph.ainvoke({
        "user_message": (
            "ABC wants to award us a turnkey manufacturing project for a new "
            "production line, contract value 1,000,000, delivered in phases."
        )
    })

    assert result["entry_type"] == "PROJECT"
    assert result["status"] == "IN_EXECUTION"
    assert result["project_id"] is not None
    assert result["project_id"].startswith("PRJ")


@pytest.mark.asyncio
async def test_export_order_is_processed():
    result = await graph.ainvoke({
        "user_message": "ABC wants to export 10 Wireless Mice to Germany, terms FOB."
    })

    assert result["entry_type"] == "EXPORT"
    assert result["status"] == "CONFIRMED"
    assert result["export_order_id"] is not None
    assert result["export_order_id"].startswith("EXP")


@pytest.mark.asyncio
async def test_consignment_transfer_is_processed():
    result = await graph.ainvoke({
        "user_message": "ABC wants to send 5 Wireless Mice to our distributor to sell on consignment."
    })

    assert result["entry_type"] == "CONSIGNMENT"
    assert result["status"] == "ACTIVE"
    assert result["consignment_id"] is not None
    assert result["consignment_id"].startswith("CNG")


@pytest.mark.asyncio
async def test_financial_adjustment_is_processed():
    # Financial got a real workflow too — every entry_type this session
    # set out to build now has one. Below the approval threshold, this
    # posts immediately in the same turn.
    result = await graph.ainvoke({
        "user_message": "Coastal Electronics Group would like a general account credit of 5000, not tied to any specific order or product."
    })

    assert result["entry_type"] == "FINANCIAL"
    assert result["status"] == "POSTED"
    assert result["financial_adjustment_id"] is not None
    assert result["financial_adjustment_id"].startswith("FA")
