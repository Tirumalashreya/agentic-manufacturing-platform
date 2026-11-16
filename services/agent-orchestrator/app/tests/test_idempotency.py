# app/tests/test_idempotency.py
import pytest

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


# Reliability-pass fix: create_sales_order used to accept idempotency_key
# and call get_idempotent_result/record_idempotent_result with NO lock at
# all around that check-then-write sequence — the sequential retry test
# above never would have caught this, since a sequential call always
# resolves without any real contention. Real OS threads, same pattern as
# the other concurrency tests in this series.
def test_create_sales_order_concurrent_same_key_creates_exactly_one_order():
    import threading

    key = "concurrent-sales-order-same-key-001"
    results: list[dict] = []

    def call():
        results.append(create_sales_order(**_order_kwargs(), idempotency_key=key))

    threads = [threading.Thread(target=call) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    order_ids = {r["sales_order_id"] for r in results if r["created"]}
    assert len(order_ids) == 1, f"expected exactly one real sales_order_id across 5 concurrent calls, got: {order_ids}"


# Reliability-pass requirement: an exception inside a locked function
# must still release the lock, so a later, unrelated operation isn't
# permanently stuck. idempotency_lock()'s try/finally already guarantees
# this (verified by code reading); this proves it holds for a REAL
# exception raised mid-body of one of the three newly-locked functions,
# not just in the abstract.
def test_create_sales_order_exception_mid_body_still_releases_the_lock():
    from unittest.mock import patch

    with patch("app.tools.sales_tools._next_sales_order_id", side_effect=RuntimeError("simulated failure mid-write")):
        with pytest.raises(RuntimeError):
            create_sales_order(**_order_kwargs())

    # If the lock were left held, this second, completely unrelated call
    # would hang forever waiting on it instead of completing normally.
    result = create_sales_order(**_order_kwargs())
    assert result["created"] is True


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
