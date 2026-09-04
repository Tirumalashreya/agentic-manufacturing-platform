# app/tests/test_approval.py
from app.tools.approval_tools import (
    create_approval_request,
    get_approval_request,
    resolve_approval_request,
)


def test_create_approval_request_is_pending():
    created = create_approval_request(
        quotation_id="Q0001",
        original_price=50000.0,
        requested_price=37500.0,
        requested_discount_percent=25.0,
        reason="Customer requested 25% off, over the 10% auto-approval limit.",
    )

    assert created["created"] is True
    assert created["status"] == "PENDING"

    fetched = get_approval_request(created["approval_id"])
    assert fetched["quotation_id"] == "Q0001"
    assert fetched["status"] == "PENDING"
    assert fetched["resolved_at"] is None


def test_resolve_approval_request_approved():
    created = create_approval_request(
        quotation_id="Q0002",
        original_price=50000.0,
        requested_price=42500.0,
        requested_discount_percent=15.0,
        reason="15% off, over limit.",
    )

    resolved = resolve_approval_request(created["approval_id"], "APPROVED", resolved_by="manager")

    assert resolved["resolved"] is True
    assert resolved["status"] == "APPROVED"
    assert resolved["requested_price"] == 42500.0

    fetched = get_approval_request(created["approval_id"])
    assert fetched["status"] == "APPROVED"
    assert fetched["resolved_by"] == "manager"
    assert fetched["resolved_at"] is not None


def test_resolve_approval_request_rejected():
    created = create_approval_request(
        quotation_id="Q0003",
        original_price=50000.0,
        requested_price=30000.0,
        requested_discount_percent=40.0,
        reason="40% off, far over limit.",
    )

    resolved = resolve_approval_request(created["approval_id"], "REJECTED")

    assert resolved["resolved"] is True
    assert resolved["status"] == "REJECTED"


def test_resolve_approval_request_cannot_double_resolve():
    created = create_approval_request(
        quotation_id="Q0004",
        original_price=50000.0,
        requested_price=40000.0,
        requested_discount_percent=20.0,
        reason="20% off, over limit.",
    )

    resolve_approval_request(created["approval_id"], "APPROVED")
    second = resolve_approval_request(created["approval_id"], "REJECTED")

    assert second["resolved"] is False


def test_resolve_approval_request_unknown_id():
    result = resolve_approval_request("A9999", "APPROVED")

    assert result["resolved"] is False


def test_resolve_approval_request_invalid_decision():
    created = create_approval_request(
        quotation_id="Q0005",
        original_price=50000.0,
        requested_price=40000.0,
        requested_discount_percent=20.0,
        reason="20% off, over limit.",
    )

    result = resolve_approval_request(created["approval_id"], "MAYBE")

    assert result["resolved"] is False
