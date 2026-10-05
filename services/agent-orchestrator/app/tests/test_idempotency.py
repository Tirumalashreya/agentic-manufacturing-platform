# app/tests/test_idempotency.py
from app.tools.idempotency_tools import get_idempotent_result, record_idempotent_result
from app.tools.sales_tools import create_sales_order
from app.tools.billing_tools import create_invoice


def test_get_idempotent_result_returns_none_when_no_key_given():
    assert get_idempotent_result(None, "create_sales_order") is None


def test_get_idempotent_result_returns_none_for_unseen_key():
    assert get_idempotent_result("unseen-key-xyz", "create_sales_order") is None


def test_record_and_retrieve_idempotent_result():
    record_idempotent_result("key-abc", "create_sales_order", {"sales_order_id": "SO0001", "created": True})

    result = get_idempotent_result("key-abc", "create_sales_order")

    assert result == {"sales_order_id": "SO0001", "created": True}


def test_idempotent_result_is_scoped_to_operation():
    record_idempotent_result("key-shared", "create_invoice", {"invoice_id": "INV0001"})

    assert get_idempotent_result("key-shared", "create_sales_order") is None
    assert get_idempotent_result("key-shared", "create_invoice") == {"invoice_id": "INV0001"}


def test_record_idempotent_result_is_a_noop_without_a_key():
    # Should not raise, and should not create a lookup-able entry.
    record_idempotent_result(None, "create_sales_order", {"sales_order_id": "SO9999"})

    assert get_idempotent_result(None, "create_sales_order") is None


def _order_kwargs(**overrides):
    kwargs = dict(
        customer_id="C001",
        customer_name="ABC Corp",
        customer_active=True,
        product_id="P011",
        product_name="Wireless Mouse",
        quantity=2,
        unit_price=800.0,
        requested_deadline=None,
    )
    kwargs.update(overrides)
    return kwargs


def test_create_sales_order_retried_with_same_key_does_not_double_create():
    key = "retry-key-001"

    first = create_sales_order(**_order_kwargs(), idempotency_key=key)
    second = create_sales_order(**_order_kwargs(), idempotency_key=key)

    assert first["created"] is True
    assert second == first
    assert second["sales_order_id"] == first["sales_order_id"]


def test_create_sales_order_without_key_still_creates_separate_orders():
    # Backward compatibility: omitting the key (every existing caller
    # before this change) must behave exactly as before — two real,
    # separate orders, not accidentally deduped.
    first = create_sales_order(**_order_kwargs())
    second = create_sales_order(**_order_kwargs())

    assert first["sales_order_id"] != second["sales_order_id"]


def test_create_sales_order_different_keys_both_create():
    first = create_sales_order(**_order_kwargs(), idempotency_key="key-A")
    second = create_sales_order(**_order_kwargs(), idempotency_key="key-B")

    assert first["sales_order_id"] != second["sales_order_id"]


def test_create_invoice_retried_with_same_key_does_not_double_bill():
    key = "invoice-retry-001"
    kwargs = dict(
        sales_order_id=None,
        delivery_id=None,
        customer_id="C001",
        customer_name="ABC Corp",
        quantity_billed=3,
        unit_price=800.0,
        payment_terms_days=30,
        notes="Test invoice.",
    )

    first = create_invoice(**kwargs, idempotency_key=key)
    second = create_invoice(**kwargs, idempotency_key=key)

    assert second["invoice_id"] == first["invoice_id"]
