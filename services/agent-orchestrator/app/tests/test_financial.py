# app/tests/test_financial.py
import pytest

from app.agents.financial_agent import financial_agent
from app.tools.financial_tools import (
    FINANCIAL_APPROVAL_THRESHOLD,
    create_financial_adjustment,
    find_financial_adjustment,
    post_financial_adjustment,
    resolve_financial_approval,
)


@pytest.mark.asyncio
async def test_financial_agent_extracts_stated_amount():
    result = await financial_agent(
        "Please issue a credit memo of 5000 to our account for a billing error, not tied to any order."
    )

    assert result.adjustment_type == "CREDIT_MEMO"
    assert result.amount == 5000


@pytest.mark.asyncio
async def test_financial_agent_never_invents_amount():
    result = await financial_agent("We'd like some kind of account adjustment, amount to be discussed.")

    assert result.amount is None


def test_create_financial_adjustment_below_threshold_auto_approves():
    result = create_financial_adjustment(
        adjustment_type="CREDIT_MEMO",
        customer_id="C001",
        customer_name="ABC Corp",
        reference=None,
        amount=5000,
        reason="Billing error goodwill credit.",
    )

    assert result["created"] is True
    assert result["financial_adjustment_id"].startswith("FA")
    assert result["approval_required"] is False
    assert result["status"] == "APPROVED"


def test_create_financial_adjustment_at_threshold_requires_approval():
    result = create_financial_adjustment(
        adjustment_type="CREDIT_MEMO",
        customer_id="C001",
        customer_name="ABC Corp",
        reference=None,
        amount=FINANCIAL_APPROVAL_THRESHOLD,
        reason="Large goodwill credit.",
    )

    assert result["created"] is True
    assert result["approval_required"] is True
    assert result["status"] == "PENDING_APPROVAL"


def test_create_financial_adjustment_rejects_missing_amount():
    result = create_financial_adjustment(
        adjustment_type="CREDIT_MEMO",
        customer_id="C001",
        customer_name="ABC Corp",
        reference=None,
        amount=None,
        reason="No amount stated.",
    )

    assert result["created"] is False


def test_create_financial_adjustment_rejects_zero_amount():
    result = create_financial_adjustment(
        adjustment_type="CREDIT_MEMO",
        customer_id="C001",
        customer_name="ABC Corp",
        reference=None,
        amount=0,
        reason="Zero amount.",
    )

    assert result["created"] is False


def test_post_financial_adjustment_requires_approved():
    created = create_financial_adjustment(
        adjustment_type="CREDIT_MEMO",
        customer_id="C001",
        customer_name="ABC Corp",
        reference=None,
        amount=FINANCIAL_APPROVAL_THRESHOLD,
        reason="Large credit, not yet approved.",
    )

    result = post_financial_adjustment(created["financial_adjustment_id"])

    assert result["posted"] is False


def test_resolve_and_post_large_adjustment():
    created = create_financial_adjustment(
        adjustment_type="DEBIT_MEMO",
        customer_id="C001",
        customer_name="ABC Corp",
        reference="INV0001",
        amount=FINANCIAL_APPROVAL_THRESHOLD,
        reason="Large correction requiring approval.",
    )

    resolved = resolve_financial_approval(created["financial_adjustment_id"], "APPROVED", approved_by="finance_lead")
    assert resolved["resolved"] is True
    assert resolved["status"] == "APPROVED"

    posted = post_financial_adjustment(created["financial_adjustment_id"])
    assert posted["posted"] is True
    assert posted["status"] == "POSTED"

    adjustment = find_financial_adjustment(created["financial_adjustment_id"])
    assert adjustment["approved_by"] == "finance_lead"
    assert adjustment["posted_at"] is not None


def test_resolve_financial_approval_rejects_large_adjustment():
    created = create_financial_adjustment(
        adjustment_type="CREDIT_MEMO",
        customer_id="C001",
        customer_name="ABC Corp",
        reference=None,
        amount=FINANCIAL_APPROVAL_THRESHOLD,
        reason="Large credit, denied.",
    )

    resolved = resolve_financial_approval(created["financial_adjustment_id"], "REJECTED")
    assert resolved["status"] == "REJECTED"

    posted = post_financial_adjustment(created["financial_adjustment_id"])
    assert posted["posted"] is False


def test_resolve_financial_approval_cannot_double_resolve():
    created = create_financial_adjustment(
        adjustment_type="CREDIT_MEMO",
        customer_id="C001",
        customer_name="ABC Corp",
        reference=None,
        amount=FINANCIAL_APPROVAL_THRESHOLD,
        reason="Large credit.",
    )
    resolve_financial_approval(created["financial_adjustment_id"], "APPROVED")

    second = resolve_financial_approval(created["financial_adjustment_id"], "REJECTED")

    assert second["resolved"] is False


def test_find_financial_adjustment_unknown_id():
    assert find_financial_adjustment("FA9999") is None
