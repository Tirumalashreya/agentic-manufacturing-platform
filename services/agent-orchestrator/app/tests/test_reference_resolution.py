# app/tests/test_reference_resolution.py
"""
Fully deterministic — no LLM anywhere. Tests resolve_reference() against
real ERP records for the cases it can actually handle today (explicit
name/id lookups), and confirms it's honest (UNSUPPORTED_REFERENCE, not a
guess) about the cases it can't (temporal/relative/ambiguous, and entity
types with no registered resolver).
"""
from app.schemas.understanding import EntityReference
from app.tools.reference_resolution import resolve_reference
from app.tools.sales_tools import create_sales_order


def _ref(**overrides):
    base = dict(entity_type="customer", identifier_type="explicit_name", identifier="ABC Corp")
    base.update(overrides)
    return EntityReference(**base)


def test_resolves_explicit_customer_name():
    result = resolve_reference(_ref(entity_type="customer", identifier_type="explicit_name", identifier="ABC Corp"))

    assert result["status"] == "RESOLVED"
    assert result["resolved_record"]["customer_id"] == "C001"


def test_resolves_explicit_sales_order_id():
    order = create_sales_order(
        customer_id="C001", customer_name="ABC Corp", customer_active=True,
        product_id="P011", product_name="Wireless Mouse", quantity=1,
        unit_price=800.0, requested_deadline=None,
    )

    result = resolve_reference(_ref(
        entity_type="sales_order", identifier_type="explicit_id", identifier=order["sales_order_id"],
    ))

    assert result["status"] == "RESOLVED"
    assert result["resolved_record"]["sales_order_id"] == order["sales_order_id"]


def test_not_found_for_unknown_explicit_identifier():
    result = resolve_reference(_ref(
        entity_type="customer", identifier_type="explicit_name", identifier="Definitely Not Real Inc",
    ))

    assert result["status"] == "NOT_FOUND"
    assert result["resolved_record"] is None


def test_unsupported_for_unregistered_entity_type():
    result = resolve_reference(_ref(
        entity_type="quotation", identifier_type="explicit_id", identifier="Q0001",
    ))

    assert result["status"] == "UNSUPPORTED_REFERENCE"
    assert "quotation" in result["reason"]


def test_unsupported_for_temporal_reference():
    result = resolve_reference(_ref(
        entity_type="sales_order", identifier_type="temporal", identifier="the order we placed last month",
    ))

    assert result["status"] == "UNSUPPORTED_REFERENCE"
    assert "query" in result["reason"].lower()


def test_unsupported_for_relative_reference():
    result = resolve_reference(_ref(
        entity_type="sales_order", identifier_type="relative", identifier="their latest order",
    ))

    assert result["status"] == "UNSUPPORTED_REFERENCE"


def test_unsupported_for_ambiguous_reference():
    result = resolve_reference(_ref(
        entity_type="sales_order", identifier_type="ambiguous", identifier="that order",
    ))

    assert result["status"] == "UNSUPPORTED_REFERENCE"
