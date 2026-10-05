# app/tests/test_negotiation.py
import pytest

from app.agents.negotiation_agent import negotiation_agent
from app.tools.pricing_tools import compute_max_discount, evaluate_negotiation


@pytest.mark.asyncio
async def test_negotiation_agent_extracts_percent():
    result = await negotiation_agent("Can you give us a 10% discount on this?")

    assert result.requested_discount_percent == 10.0
    assert result.requested_price is None


@pytest.mark.asyncio
async def test_negotiation_agent_extracts_target_price():
    result = await negotiation_agent("Can you do it for 45000 each instead of 50000?")

    assert result.requested_price == 45000.0
    assert result.requested_discount_percent is None


def test_compute_max_discount_low_tier():
    # Tier A product (<5000), small order (<20), standard customer (<200k)
    # -> 3% base + 0% + 0% = 3%
    result = compute_max_discount(product_price=3000, quantity=5, customer_credit_limit=50000)

    assert result["max_discount_percent"] == 3


def test_compute_max_discount_mid_tier_matches_example():
    # Tier C product (>50000), medium order (20-99), preferred tier (200k-500k)
    # -> 8% + 2% + 2% = 12%, matching the user's own worked example.
    result = compute_max_discount(product_price=100000, quantity=50, customer_credit_limit=300000)

    assert result["max_discount_percent"] == 12


def test_compute_max_discount_caps_at_ceiling():
    # Tier C product, bulk order (>=100), premium tier (>500k)
    # -> 8% + 4% + 4% = 16%, capped to 15%.
    result = compute_max_discount(product_price=400000, quantity=150, customer_credit_limit=1000000)

    assert result["raw_total_percent"] == 16
    assert result["max_discount_percent"] == 15


def test_evaluate_negotiation_within_authority_low_tier():
    result = evaluate_negotiation(
        original_price=3000.0,
        quantity=5,
        customer_credit_limit=50000.0,
        requested_discount_percent=2.0,
        requested_price=None,
    )

    assert result["evaluated"] is True
    assert result["max_auto_approved_percent"] == 3
    assert result["within_authority"] is True
    assert result["status"] == "REVISED"


def test_evaluate_negotiation_outside_authority_low_tier():
    result = evaluate_negotiation(
        original_price=3000.0,
        quantity=5,
        customer_credit_limit=50000.0,
        requested_discount_percent=10.0,
        requested_price=None,
    )

    assert result["evaluated"] is True
    assert result["max_auto_approved_percent"] == 3
    assert result["within_authority"] is False
    assert result["status"] == "REQUIRES_APPROVAL"
    assert result["revised_price"] is None


def test_evaluate_negotiation_within_authority_high_tier():
    # Same 25% ask that used to require approval under the old flat 10%
    # ceiling now auto-approves for a high-value, bulk, premium-tier order.
    result = evaluate_negotiation(
        original_price=400000.0,
        quantity=150,
        customer_credit_limit=1000000.0,
        requested_discount_percent=15.0,
        requested_price=None,
    )

    assert result["max_auto_approved_percent"] == 15
    assert result["within_authority"] is True
    assert result["status"] == "REVISED"


def test_evaluate_negotiation_converts_target_price_to_percent():
    result = evaluate_negotiation(
        original_price=100000.0,
        quantity=50,
        customer_credit_limit=300000.0,
        requested_discount_percent=None,
        requested_price=90000.0,
    )

    assert result["evaluated"] is True
    assert result["requested_discount_percent"] == 10.0
    assert result["max_auto_approved_percent"] == 12
    assert result["within_authority"] is True
    assert result["status"] == "REVISED"


def test_evaluate_negotiation_no_request_specified():
    result = evaluate_negotiation(
        original_price=50000.0,
        quantity=10,
        customer_credit_limit=100000.0,
        requested_discount_percent=None,
        requested_price=None,
    )

    assert result["evaluated"] is False


def test_evaluate_negotiation_rejects_zero_price():
    result = evaluate_negotiation(
        original_price=0.0,
        quantity=10,
        customer_credit_limit=100000.0,
        requested_discount_percent=10.0,
        requested_price=None,
    )

    assert result["evaluated"] is False
