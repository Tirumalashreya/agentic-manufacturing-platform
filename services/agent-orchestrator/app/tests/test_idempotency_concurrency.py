# app/tests/test_idempotency_concurrency.py
"""Independent-audit P1 fix: get_idempotent_result/record_idempotent_result
did an unsynchronized check-then-write against mock_erp.xlsx — two
concurrent requests for the same idempotency_key could both see "no
cached result" and both execute the real operation. create_delivery/
create_invoice (the two functions _deliver_and_bill calls) are now
wrapped in idempotency_lock(), a real fcntl.flock-based lock covering the
whole check -> execute -> record sequence, not just the final write.

Uses real threads (not mocks) against the real mock_erp.xlsx, protected
by conftest.py's session-scoped backup/restore — this is the only way to
actually exercise the lock rather than assume it works from reading the
code.
"""
import threading

from app.tools.billing_tools import create_invoice
from app.tools.delivery_tools import create_delivery


def test_concurrent_create_invoice_calls_with_the_same_key_produce_exactly_one_real_invoice():
    key = "concurrency-test-invoice-key-001"
    results: list[dict] = []
    errors: list[Exception] = []

    def call():
        try:
            results.append(
                create_invoice(
                    sales_order_id="SO-CONC-1", delivery_id="DEL-CONC-1",
                    customer_id="C018", customer_name="Northgate Traders",
                    quantity_billed=5, unit_price=800.0,
                    payment_terms_days=30, notes="concurrency test",
                    idempotency_key=key,
                )
            )
        except Exception as exc:  # noqa: BLE001 — captured for the assertion below, not swallowed
            errors.append(exc)

    threads = [threading.Thread(target=call) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors, f"concurrent create_invoice calls raised: {errors}"
    assert len(results) == 5
    # The real proof: every single call — not just a plausible-looking
    # majority — got back the identical invoice_id. If the lock had any
    # gap, at least one of the 5 concurrent calls would have raced past
    # the cache check before the first writer recorded its result and
    # created a second real INV row with a different id.
    invoice_ids = {r["invoice_id"] for r in results}
    assert len(invoice_ids) == 1, f"expected exactly one real invoice, got {invoice_ids}"


def test_concurrent_create_delivery_calls_with_the_same_key_produce_exactly_one_real_delivery():
    key = "concurrency-test-delivery-key-001"
    results: list[dict] = []
    errors: list[Exception] = []

    def call():
        try:
            results.append(
                create_delivery(
                    sales_order_id="SO-CONC-2", customer_id="C018", customer_name="Northgate Traders",
                    product_id="P011", product_name="Wireless Mouse", quantity=5,
                    idempotency_key=key,
                )
            )
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=call) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors, f"concurrent create_delivery calls raised: {errors}"
    assert len(results) == 5
    delivery_ids = {r["delivery_id"] for r in results}
    assert len(delivery_ids) == 1, f"expected exactly one real delivery, got {delivery_ids}"


def test_concurrent_calls_with_different_keys_still_each_create_their_own_real_record():
    # The lock must serialize access, not prevent genuinely distinct
    # operations from each going through — 5 different keys should
    # produce 5 different invoices, not be incorrectly collapsed into one.
    results: list[dict] = []

    def call(key: str):
        results.append(
            create_invoice(
                sales_order_id="SO-CONC-3", delivery_id="DEL-CONC-3",
                customer_id="C018", customer_name="Northgate Traders",
                quantity_billed=1, unit_price=800.0,
                payment_terms_days=30, notes="distinct-key test",
                idempotency_key=key,
            )
        )

    threads = [threading.Thread(target=call, args=(f"concurrency-distinct-key-{i}",)) for i in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    invoice_ids = {r["invoice_id"] for r in results}
    assert len(invoice_ids) == 5  # five distinct keys -> five distinct real invoices


def test_replay_behavior_is_preserved_sequential_retry_returns_the_cached_result_verbatim():
    key = "sequential-replay-key-001"
    first = create_invoice(
        sales_order_id="SO-SEQ-1", delivery_id="DEL-SEQ-1",
        customer_id="C018", customer_name="Northgate Traders",
        quantity_billed=3, unit_price=800.0,
        payment_terms_days=30, notes="original", idempotency_key=key,
    )
    second = create_invoice(
        sales_order_id="SO-SEQ-1", delivery_id="DEL-SEQ-1",
        customer_id="C018", customer_name="Northgate Traders",
        quantity_billed=3, unit_price=800.0,
        payment_terms_days=30, notes="original", idempotency_key=key,
    )
    assert second == first  # unchanged behavior: verbatim replay, not re-executed


def test_existing_same_key_different_body_behavior_is_unchanged_not_newly_broken():
    # Documents a real, pre-existing limitation this fix does NOT change:
    # get_idempotent_result matches on (key, operation) only, with no
    # request-body hash comparison — unlike the TS withIdempotency
    # mechanism. A same-key-different-quantity retry still silently
    # returns the FIRST result. Not introduced by this fix; not fixed by
    # it either — asserted here so a future change to this behavior is a
    # deliberate decision, not an accidental regression.
    key = "mismatch-key-001"
    first = create_invoice(
        sales_order_id="SO-MISMATCH-1", delivery_id="DEL-MISMATCH-1",
        customer_id="C018", customer_name="Northgate Traders",
        quantity_billed=2, unit_price=800.0,
        payment_terms_days=30, notes="first body", idempotency_key=key,
    )
    second = create_invoice(
        sales_order_id="SO-MISMATCH-1", delivery_id="DEL-MISMATCH-1",
        customer_id="C018", customer_name="Northgate Traders",
        quantity_billed=999, unit_price=800.0,  # different quantity, same key
        payment_terms_days=30, notes="different body", idempotency_key=key,
    )
    assert second == first  # still the ORIGINAL (quantity=2) result — pre-existing behavior, preserved as-is
