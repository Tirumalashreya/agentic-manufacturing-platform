# app/tests/test_subscription.py
import pytest

from app.agents.subscription_agent import subscription_agent
from app.tools.subscription_tools import (
    create_subscription,
    find_subscription_plan,
    find_active_subscription,
    renew_subscription,
    cancel_subscription,
)


@pytest.mark.asyncio
async def test_subscription_agent_extracts_renewal():
    result = await subscription_agent("ABC wants to renew their annual software subscription for 1 year.")

    assert result.action == "RENEWAL"
    assert len(result.requested_plan_name) > 0


@pytest.mark.asyncio
async def test_subscription_agent_extracts_new_signup():
    result = await subscription_agent("We'd like to sign up for the Gold Support plan.")

    assert result.action == "NEW"
    assert "gold" in result.requested_plan_name.lower()


def test_find_subscription_plan_exact_match():
    plan = find_subscription_plan("Gold Support")

    assert plan is not None
    assert plan["plan_id"] == "PLN002"
    assert plan["price"] == 50000


def test_find_subscription_plan_substring_match():
    plan = find_subscription_plan("annual software subscription")

    assert plan is not None
    assert plan["plan_name"] == "Annual Software Subscription"


def test_find_subscription_plan_no_match():
    plan = find_subscription_plan("Nonexistent Platinum Ultra Plan")

    assert plan is None


def test_create_subscription_succeeds():
    result = create_subscription(
        customer_id="C001",
        customer_name="ABC Corp",
        plan_id="PLN002",
        plan_name="Gold Support",
        price=50000,
        billing_frequency="ANNUAL",
        action="NEW",
    )

    assert result["created"] is True
    assert result["subscription_id"].startswith("SUB")
    assert result["status"] == "ACTIVE"


@pytest.mark.asyncio
async def test_subscription_agent_extracts_cancel():
    result = await subscription_agent("Please cancel our Cloud Hosting subscription.")

    assert result.action == "CANCEL"
    assert "cloud hosting" in result.requested_plan_name.lower()


def test_find_active_subscription_finds_created_one():
    created = create_subscription(
        customer_id="C002",
        customer_name="XYZ Inc",
        plan_id="PLN003",
        plan_name="Cloud Hosting",
        price=15000,
        billing_frequency="MONTHLY",
        action="NEW",
    )

    found = find_active_subscription("C002", "PLN003")

    assert found is not None
    assert found["subscription_id"] == created["subscription_id"]


def test_find_active_subscription_no_match():
    found = find_active_subscription("C999", "PLN999")

    assert found is None


def test_renew_subscription_extends_renewal_date():
    created = create_subscription(
        customer_id="C003",
        customer_name="Acme Ltd",
        plan_id="PLN003",
        plan_name="Cloud Hosting",
        price=15000,
        billing_frequency="MONTHLY",
        action="NEW",
    )

    result = renew_subscription(created["subscription_id"])

    assert result["renewed"] is True
    assert result["renewal_date"] > created["renewal_date"]


def test_renew_subscription_no_such_subscription():
    result = renew_subscription("SUB9999")

    assert result["renewed"] is False


def test_cancel_subscription_succeeds():
    created = create_subscription(
        customer_id="C004",
        customer_name="Delta Co",
        plan_id="PLN001",
        plan_name="Basic Support",
        price=5000,
        billing_frequency="MONTHLY",
        action="NEW",
    )

    result = cancel_subscription(created["subscription_id"])

    assert result["cancelled"] is True
    assert result["status"] == "CANCELLED"
    assert find_active_subscription("C004", "PLN001") is None


def test_cancel_subscription_already_cancelled_rejected():
    created = create_subscription(
        customer_id="C005",
        customer_name="Echo Corp",
        plan_id="PLN001",
        plan_name="Basic Support",
        price=5000,
        billing_frequency="MONTHLY",
        action="NEW",
    )
    cancel_subscription(created["subscription_id"])

    result = cancel_subscription(created["subscription_id"])

    assert result["cancelled"] is False
