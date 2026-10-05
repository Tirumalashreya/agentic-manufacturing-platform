# app/tests/test_financial.py
from unittest.mock import patch

import httpx
import pytest
from groq import BadRequestError

from app.agents.financial_agent import financial_agent
from app.graph import financial_node
from app.tools.financial_tools import (
    FINANCIAL_APPROVAL_THRESHOLD,
    create_financial_adjustment,
    find_financial_adjustment,
    list_actionable_financial_adjustments,
    post_financial_adjustment,
    resolve_financial_approval,
)


def _tool_use_failed_error() -> BadRequestError:
    response = httpx.Response(400, request=httpx.Request("POST", "http://groq.test"))
    return BadRequestError("tool_use_failed", response=response, body=None)


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


def test_list_actionable_financial_adjustments_includes_pending_and_approved_not_posted():
    pending = create_financial_adjustment(
        adjustment_type="CREDIT_MEMO",
        customer_id="C001",
        customer_name="ABC Corp",
        reference=None,
        amount=FINANCIAL_APPROVAL_THRESHOLD,
        reason="Awaiting a decision.",
    )
    approved = create_financial_adjustment(
        adjustment_type="DEBIT_MEMO",
        customer_id="C001",
        customer_name="ABC Corp",
        reference=None,
        amount=FINANCIAL_APPROVAL_THRESHOLD,
        reason="Approved, not yet posted.",
    )
    resolve_financial_approval(approved["financial_adjustment_id"], "APPROVED")

    ids = {row["financial_adjustment_id"] for row in list_actionable_financial_adjustments()}

    assert pending["financial_adjustment_id"] in ids
    assert approved["financial_adjustment_id"] in ids


def test_list_actionable_financial_adjustments_excludes_terminal_statuses():
    # Auto-approval only sets status=APPROVED — graph.py's financial_node is
    # what actually calls post_financial_adjustment() right after, same as
    # here, to reach the terminal POSTED state.
    auto_approved = create_financial_adjustment(
        adjustment_type="CREDIT_MEMO",
        customer_id="C001",
        customer_name="ABC Corp",
        reference=None,
        amount=100,
        reason="Small, posts immediately.",
    )
    post_financial_adjustment(auto_approved["financial_adjustment_id"])
    rejected = create_financial_adjustment(
        adjustment_type="CREDIT_MEMO",
        customer_id="C001",
        customer_name="ABC Corp",
        reference=None,
        amount=FINANCIAL_APPROVAL_THRESHOLD,
        reason="Will be rejected.",
    )
    resolve_financial_approval(rejected["financial_adjustment_id"], "REJECTED")

    ids = {row["financial_adjustment_id"] for row in list_actionable_financial_adjustments()}

    assert auto_approved["financial_adjustment_id"] not in ids
    assert rejected["financial_adjustment_id"] not in ids


@pytest.mark.asyncio
async def test_financial_node_rejects_gracefully_when_agent_cannot_extract():
    # Simulates financial_agent's own retry wrapper exhausting all 5
    # attempts on the documented tool_use_failed flake (challenge.md) —
    # in practice this happens when entry_router sends a non-financial
    # request here (product_valid=false rerouted a real product order),
    # and the model correctly refuses to extract financial fields from it.
    # This must surface as a clean REJECTED response, not an unhandled 500.
    with patch("app.graph.financial_agent", side_effect=_tool_use_failed_error()):
        result = await financial_node({
            "user_message": "Create an order for 30 pumps for Delta Manufacturing.",
            "customer_id": None,
            "customer_name": None,
        })

    assert result["status"] == "REJECTED"
    assert "financial adjustment" in result["response"].lower()


@pytest.mark.asyncio
async def test_financial_node_reraises_unrelated_bad_request_errors():
    response = httpx.Response(400, request=httpx.Request("POST", "http://groq.test"))
    other_error = BadRequestError("invalid_api_key", response=response, body=None)

    with patch("app.graph.financial_agent", side_effect=other_error):
        with pytest.raises(BadRequestError):
            await financial_node({
                "user_message": "Issue a credit memo for 5000.",
                "customer_id": "C001",
                "customer_name": "ABC Corp",
            })
