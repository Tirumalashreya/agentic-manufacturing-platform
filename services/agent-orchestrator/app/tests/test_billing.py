# app/tests/test_billing.py
from unittest.mock import patch

import pytest

from app import db
from app.agents.billing_agent import billing_agent
from app.tools.billing_tools import create_invoice


@pytest.mark.asyncio
async def test_billing_agent_full_delivery():
    result = await billing_agent(
        quantity_delivered=10,
        quantity_ordered=10,
        unit_price=800.0,
    )

    assert result.payment_terms_days > 0


@pytest.mark.asyncio
async def test_billing_agent_partial_delivery_notes_it():
    result = await billing_agent(
        quantity_delivered=40,
        quantity_ordered=100,
        unit_price=50000.0,
    )

    assert "partial" in result.notes.lower() or "remain" in result.notes.lower()


def test_create_invoice_succeeds():
    result = create_invoice(
        sales_order_id="SO0001",
        delivery_id="DEL0001",
        customer_id="C001",
        customer_name="ABC Corp",
        quantity_billed=5,
        unit_price=800.0,
        payment_terms_days=30,
        notes="Full delivery.",
    )

    assert result["created"] is True
    assert result["invoice_amount"] == 4000.0
    assert result["invoice_id"].startswith("INV")


def test_create_invoice_rejects_bad_quantity():
    result = create_invoice(
        sales_order_id="SO0001",
        delivery_id="DEL0001",
        customer_id="C001",
        customer_name="ABC Corp",
        quantity_billed=0,
        unit_price=800.0,
        payment_terms_days=30,
        notes="",
    )

    assert result["created"] is False


# Pilot-readiness work: Invoice dual-write. Same live-order-service,
# real-Postgres verification as test_delivery.py's own dual-write test.
@pytest.mark.asyncio
async def test_create_invoice_dual_writes_a_real_postgres_row():
    result = create_invoice(
        sales_order_id=None, delivery_id=None, customer_id="C001", customer_name="ABC Corp",
        quantity_billed=3, unit_price=800.0, payment_terms_days=30, notes="dual-write test",
    )
    assert result["created"] is True

    conn = await db.get_connection()
    try:
        row = await conn.fetchrow(
            'SELECT "quantityBilled", "invoiceAmount", status FROM "Invoice" WHERE "externalInvoiceId" = $1',
            result["invoice_id"],
        )
    finally:
        await conn.close()

    assert row is not None, "the dual-write did not create a real Invoice row in Postgres"
    assert row["quantityBilled"] == 3
    assert row["invoiceAmount"] == 2400.0
    assert row["status"] == "ISSUED"


def test_create_invoice_still_succeeds_when_the_postgres_mirror_fails():
    with patch("app.tools.billing_tools.dual_write_invoice", side_effect=RuntimeError("simulated order-service outage")):
        result = create_invoice(
            sales_order_id="SO0001", delivery_id="DEL0001", customer_id="C001", customer_name="ABC Corp",
            quantity_billed=5, unit_price=800.0, payment_terms_days=30, notes="Full delivery.",
        )

    assert result["created"] is True
    assert result["invoice_amount"] == 4000.0
    # Reliability-pass fix: Excel/Postgres are never claimed atomic — a
    # failed mirror must be visible on the result, not silently reported
    # as fully synchronized.
    assert result["postgres_synced"] is False


# Reliability-pass fix (lock-blocking): the Postgres dual-write used to
# run INSIDE create_invoice's own @idempotency_lock(), so a slow mirror
# call stalled every other Excel write in the app behind it. Proves the
# opposite now: an unrelated, independent Excel write (record_audit_event)
# started WHILE create_invoice's dual-write is still sleeping completes
# immediately, never waiting on it.
def test_create_invoice_does_not_block_an_unrelated_excel_write_while_its_dual_write_is_slow():
    import threading
    import time

    from app.tools.audit_tools import record_audit_event

    dual_write_started = threading.Event()
    release_dual_write = threading.Event()

    def slow_dual_write(**kwargs):
        dual_write_started.set()
        release_dual_write.wait(timeout=5)
        return {"id": "whatever"}

    invoice_result = {}

    def do_invoice():
        with patch("app.tools.billing_tools.dual_write_invoice", side_effect=slow_dual_write):
            invoice_result["result"] = create_invoice(
                sales_order_id="SO0001", delivery_id="DEL0001", customer_id="C001", customer_name="ABC Corp",
                quantity_billed=1, unit_price=100.0, payment_terms_days=30, notes="slow dual-write",
            )

    invoice_thread = threading.Thread(target=do_invoice)
    invoice_thread.start()
    assert dual_write_started.wait(timeout=5), "dual-write never started"

    # The real proof: this unrelated Excel write starts and finishes
    # while the invoice's dual-write is still blocked mid-flight.
    t0 = time.monotonic()
    record_audit_event("StressTest", "ENT-UNBLOCKED-CHECK", "CHECK", {})
    unrelated_write_duration = time.monotonic() - t0

    release_dual_write.set()
    invoice_thread.join(timeout=5)

    assert unrelated_write_duration < 1.0, (
        f"record_audit_event took {unrelated_write_duration:.2f}s — it waited on the invoice's dual-write"
    )
    assert invoice_result["result"]["created"] is True


# Same-key concurrency: the Excel-side business write must happen
# exactly once regardless of how many concurrent callers share a key —
# this is what actually prevents two real Invoice rows for one logical
# request, independent of whatever the (now-unlocked, retried) dual-write
# does.
def test_create_invoice_concurrent_same_key_creates_exactly_one_invoice_row():
    import threading

    from app.tools.billing_tools import list_invoices

    key = "concurrent-invoice-same-key-001"
    results: list[dict] = []

    def call():
        results.append(create_invoice(
            sales_order_id="SO0001", delivery_id="DEL0001", customer_id="C001", customer_name="ABC Corp",
            quantity_billed=1, unit_price=500.0, payment_terms_days=30, notes="same-key concurrency",
            idempotency_key=key,
        ))

    threads = [threading.Thread(target=call) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    invoice_ids = {r["invoice_id"] for r in results if r["created"]}
    assert len(invoice_ids) == 1, f"expected exactly one real invoice_id across 5 concurrent calls, got: {invoice_ids}"

    matching_rows = [inv for inv in list_invoices() if inv["invoice_id"] in invoice_ids]
    assert len(matching_rows) == 1  # exactly one real row written, not five


# Recovery: a genuine retry with the same key, after the first attempt's
# Postgres mirror failed, must (a) never create a second Excel Invoice
# row, and (b) get a real second chance at the mirror, since
# dual_write_invoice is upsert-keyed and safe to repeat.
def test_create_invoice_retry_after_failed_sync_recovers_without_duplicating_the_excel_row():
    key = "invoice-retry-after-failed-sync-001"

    with patch("app.tools.billing_tools.dual_write_invoice", side_effect=RuntimeError("simulated outage")):
        first = create_invoice(
            sales_order_id="SO0001", delivery_id="DEL0001", customer_id="C001", customer_name="ABC Corp",
            quantity_billed=1, unit_price=100.0, payment_terms_days=30, notes="will fail sync",
            idempotency_key=key,
        )
    assert first["created"] is True
    assert first["postgres_synced"] is False

    with patch("app.tools.billing_tools.dual_write_invoice") as mock_dual_write:
        retried = create_invoice(
            sales_order_id="SO0001", delivery_id="DEL0001", customer_id="C001", customer_name="ABC Corp",
            quantity_billed=1, unit_price=100.0, payment_terms_days=30, notes="will fail sync",
            idempotency_key=key,
        )

    assert retried["invoice_id"] == first["invoice_id"]  # same Excel row, never duplicated
    assert retried["postgres_synced"] is True  # the retry gave the mirror a real second chance
    mock_dual_write.assert_called_once()
