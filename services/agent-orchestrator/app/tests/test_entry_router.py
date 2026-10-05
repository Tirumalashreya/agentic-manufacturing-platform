# app/tests/test_entry_router.py
import pytest

from app.graph import entry_router, graph


def _state(**overrides):
    base = {
        "entry_type": "DIRECT_SALES",
        "mentions_product_or_service": False,
        "mentions_financial_adjustment": False,
    }
    base.update(overrides)
    return base


def test_entry_router_overrides_financial_when_product_mentioned_without_financial_language():
    # The exact bug this session found live: "order 30 pumps" has no
    # recognizable product, process_agent forces FINANCIAL per its own
    # prompt, but the request plainly isn't about money at all.
    result = entry_router(_state(
        entry_type="FINANCIAL",
        mentions_product_or_service=True,
        mentions_financial_adjustment=False,
    ))

    assert result == "unclear"


def test_entry_router_does_not_override_a_genuine_financial_adjustment():
    result = entry_router(_state(
        entry_type="FINANCIAL",
        mentions_product_or_service=False,
        mentions_financial_adjustment=True,
    ))

    assert result == "financial"


def test_entry_router_does_not_override_financial_when_both_mentioned():
    # A financial adjustment can legitimately reference a product/order
    # (e.g. "credit memo for the damaged laptops") — the override is
    # deliberately scoped to "product language with NO financial language
    # at all", not "product language present".
    result = entry_router(_state(
        entry_type="FINANCIAL",
        mentions_product_or_service=True,
        mentions_financial_adjustment=True,
    ))

    assert result == "financial"


def test_entry_router_ignores_understanding_signals_for_non_financial_entry_types():
    result = entry_router(_state(
        entry_type="DIRECT_SALES",
        mentions_product_or_service=True,
        mentions_financial_adjustment=False,
    ))

    assert result == "direct_sales"


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
    # This test's actual job is verifying DIRECT_SALES routing, not the
    # credit outcome (that has its own dedicated tests) — so it must not
    # depend on any specific customer's accumulated exposure staying low
    # across a long-lived shared mock_erp.xlsx. Coastal Electronics Group
    # used to have enough headroom for this to always land CONFIRMED, but
    # heavy live testing this session pushed its real exposure close to
    # its limit, which is exactly the kind of shared-state fragility this
    # rewrite avoids by branching on the real outcome instead of assuming
    # one.
    result = await graph.ainvoke({
        "user_message": "Coastal Electronics Group wants to order 5 laptops now."
    })

    assert result["entry_type"] == "DIRECT_SALES"
    assert result["sales_order_id"] is not None

    if result["credit_within_limit"]:
        assert result["sales_order_status"] == "CONFIRMED"
        assert result["fulfillment_strategy"] in ("MTS", "MTO", "CTO", "THIRD_PARTY", "INTERCOMPANY", "HYBRID")
        assert result["fulfillment_from_stock"] + result["fulfillment_to_produce"] == 5
        assert result["status"] in ("FULFILLED", "BILLED", "IN_PRODUCTION", "PARTIALLY_IN_PRODUCTION", "PENDING_MANUAL_ACTION")
    else:
        assert result["sales_order_status"] == "CREDIT_BLOCKED"
        assert result["status"] == "ON_CREDIT_HOLD"


@pytest.mark.asyncio
async def test_create_order_for_unregistered_customer_lands_on_credit_hold():
    # Stale name/assertion fixed: context_agent now auto-provisions an
    # unresolved customer with a modest starter credit limit (see
    # NEW_CUSTOMER_STARTER_CREDIT_LIMIT in customer_tools.py) instead of
    # rejecting the request outright — a real "no such customer at all"
    # outcome no longer exists once the customer is auto-created before
    # credit_check_node ever runs. A 100-unit order comfortably exceeds
    # that starter limit, so it correctly lands on credit hold. Note
    # direct_sales_node creates the order record before credit_check_node
    # runs (so it can exclude the order's own amount from its own
    # exposure calculation) — a real sales_order_id does exist here, just
    # with status CREDIT_BLOCKED, not None.
    result = await graph.ainvoke({
        "user_message": "Some Unregistered Company wants to order 100 laptops now."
    })

    assert result["entry_type"] == "DIRECT_SALES"
    assert result["status"] == "ON_CREDIT_HOLD"
    assert result["sales_order_status"] == "CREDIT_BLOCKED"


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


@pytest.mark.asyncio
async def test_unrecognized_product_order_asks_for_clarification_not_financial():
    # The exact bug this session found live via manual testing: "Delta
    # Manufacturing" isn't a real customer and "pumps" isn't a real
    # product in this catalog, so product_valid=false — which used to
    # force process_agent into FINANCIAL and then crash/reject on a
    # missing amount. Now the request_understanding override should catch
    # it and turn it into a real clarification question instead.
    result = await graph.ainvoke({
        "user_message": (
            "Create an order for 30 pumps for Delta Manufacturing. They need a specific "
            "configuration with a higher-pressure rating and stainless-steel components."
        )
    })

    assert result["needs_clarification"] is True
    assert result["clarification_question"] is not None
    assert result["status"] == "NEEDS_CLARIFICATION"
    assert result["mentions_product_or_service"] is True
    assert result["mentions_financial_adjustment"] is False
