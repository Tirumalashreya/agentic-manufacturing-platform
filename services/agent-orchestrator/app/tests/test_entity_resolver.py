# app/tests/test_entity_resolver.py
from app.tools.entity_resolver import (
    KNOWN_ENTITY_TYPES,
    UNRESOLVABLE_ENTITY_TYPES,
    resolve_entity,
)
from app.tools.project_tools import create_project
from app.tools.sales_tools import create_sales_order


def test_resolve_entity_customer():
    result = resolve_entity("customer", "ABC Corp")

    assert result is not None
    assert result["customer_id"] == "C001"


def test_resolve_entity_product():
    result = resolve_entity("product", "Wireless Mouse")

    assert result is not None
    assert result["product_id"] == "P011"


def test_resolve_entity_sales_order_real_record():
    created = create_sales_order(
        customer_id="C001", customer_name="ABC Corp", customer_active=True,
        product_id="P011", product_name="Wireless Mouse", quantity=1,
        unit_price=800.0, requested_deadline=None,
    )

    result = resolve_entity("sales_order", created["sales_order_id"])

    assert result is not None
    assert result["sales_order_id"] == created["sales_order_id"]


def test_resolve_entity_project_real_record():
    created = create_project(
        customer_id="C001", customer_name="ABC Corp", product_id=None,
        product_name=None, quantity=None, project_type="Manufacturing",
        scope_description="Resolver test project.", contract_value=100000,
    )

    result = resolve_entity("project", created["project_id"])

    assert result is not None
    assert result["project_id"] == created["project_id"]


def test_resolve_entity_unknown_identifier_returns_none():
    assert resolve_entity("sales_order", "SO9999999") is None


def test_resolve_entity_unknown_type_returns_none():
    assert resolve_entity("not_a_real_entity_type", "anything") is None


def test_resolve_entity_none_identifier_returns_none():
    assert resolve_entity("customer", None) is None


def test_known_entity_types_matches_registered_resolvers():
    assert "customer" in KNOWN_ENTITY_TYPES
    assert "sales_order" in KNOWN_ENTITY_TYPES
    assert "project" in KNOWN_ENTITY_TYPES
    # Deliberately not registered — no real lookup exists for these yet.
    for entity_type in UNRESOLVABLE_ENTITY_TYPES:
        assert entity_type not in KNOWN_ENTITY_TYPES
