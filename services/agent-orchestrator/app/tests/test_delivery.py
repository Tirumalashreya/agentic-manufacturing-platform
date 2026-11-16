# app/tests/test_delivery.py
from unittest.mock import patch

import pytest

from app import db
from app.tools.delivery_tools import create_delivery


def test_create_delivery_succeeds():
    result = create_delivery(
        sales_order_id="SO0001",
        customer_id="C001",
        customer_name="ABC Corp",
        product_id="P011",
        product_name="Wireless Mouse",
        quantity=5,
    )

    assert result["created"] is True
    assert result["delivery_id"].startswith("DEL")
    assert result["status"] == "DISPATCHED"


def test_create_delivery_rejects_bad_quantity():
    result = create_delivery(
        sales_order_id="SO0001",
        customer_id="C001",
        customer_name="ABC Corp",
        product_id="P011",
        product_name="Wireless Mouse",
        quantity=0,
    )

    assert result["created"] is False


# Pilot-readiness work: Delivery dual-write. order-service is genuinely
# live in this test environment (confirmed listening on :4001, connected
# to the same real dev Postgres every TS test in this session already
# uses) — this verifies the REAL Postgres row, not a mocked HTTP call.
@pytest.mark.asyncio
async def test_create_delivery_dual_writes_a_real_postgres_row():
    result = create_delivery(
        sales_order_id=None, customer_id="C001", customer_name="ABC Corp",
        product_id="P011", product_name="Wireless Mouse", quantity=7,
    )
    assert result["created"] is True

    conn = await db.get_connection()
    try:
        row = await conn.fetchrow(
            'SELECT quantity, status, "customerId" FROM "Delivery" WHERE "externalDeliveryId" = $1',
            result["delivery_id"],
        )
    finally:
        await conn.close()

    assert row is not None, "the dual-write did not create a real Delivery row in Postgres"
    assert row["quantity"] == 7
    assert row["status"] == "DISPATCHED"
    assert row["customerId"] == "C001"


def test_create_delivery_still_succeeds_when_the_postgres_mirror_fails():
    # The core guarantee: a dual-write failure must never fail or
    # mutate the result of the real, already-committed Excel write.
    with patch("app.tools.delivery_tools.dual_write_delivery", side_effect=RuntimeError("simulated order-service outage")):
        result = create_delivery(
            sales_order_id="SO0001", customer_id="C001", customer_name="ABC Corp",
            product_id="P011", product_name="Wireless Mouse", quantity=2,
        )

    assert result["created"] is True
    assert result["delivery_id"].startswith("DEL")
    # Reliability-pass fix: Excel/Postgres are never claimed atomic — a
    # failed mirror must be visible on the result.
    assert result["postgres_synced"] is False


# Reliability-pass fix (lock-blocking): same proof as billing_tools'
# create_invoice — the Postgres dual-write used to run INSIDE
# create_delivery's own @idempotency_lock(), so a slow mirror call
# stalled every other Excel write app-wide behind it.
def test_create_delivery_does_not_block_an_unrelated_excel_write_while_its_dual_write_is_slow():
    import threading
    import time

    from app.tools.audit_tools import record_audit_event

    dual_write_started = threading.Event()
    release_dual_write = threading.Event()

    def slow_dual_write(**kwargs):
        dual_write_started.set()
        release_dual_write.wait(timeout=5)
        return {"id": "whatever"}

    delivery_result = {}

    def do_delivery():
        with patch("app.tools.delivery_tools.dual_write_delivery", side_effect=slow_dual_write):
            delivery_result["result"] = create_delivery(
                sales_order_id="SO0001", customer_id="C001", customer_name="ABC Corp",
                product_id="P011", product_name="Wireless Mouse", quantity=1,
            )

    delivery_thread = threading.Thread(target=do_delivery)
    delivery_thread.start()
    assert dual_write_started.wait(timeout=5), "dual-write never started"

    t0 = time.monotonic()
    record_audit_event("StressTest", "ENT-UNBLOCKED-CHECK-DELIVERY", "CHECK", {})
    unrelated_write_duration = time.monotonic() - t0

    release_dual_write.set()
    delivery_thread.join(timeout=5)

    assert unrelated_write_duration < 1.0, (
        f"record_audit_event took {unrelated_write_duration:.2f}s — it waited on the delivery's dual-write"
    )
    assert delivery_result["result"]["created"] is True


def test_create_delivery_concurrent_same_key_creates_exactly_one_delivery_row():
    import threading

    key = "concurrent-delivery-same-key-001"
    results: list[dict] = []

    def call():
        results.append(create_delivery(
            sales_order_id="SO0001", customer_id="C001", customer_name="ABC Corp",
            product_id="P011", product_name="Wireless Mouse", quantity=1,
            idempotency_key=key,
        ))

    threads = [threading.Thread(target=call) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    delivery_ids = {r["delivery_id"] for r in results if r["created"]}
    assert len(delivery_ids) == 1, f"expected exactly one real delivery_id across 5 concurrent calls, got: {delivery_ids}"


def test_create_delivery_retry_after_failed_sync_recovers_without_duplicating_the_excel_row():
    key = "delivery-retry-after-failed-sync-001"

    with patch("app.tools.delivery_tools.dual_write_delivery", side_effect=RuntimeError("simulated outage")):
        first = create_delivery(
            sales_order_id="SO0001", customer_id="C001", customer_name="ABC Corp",
            product_id="P011", product_name="Wireless Mouse", quantity=1,
            idempotency_key=key,
        )
    assert first["created"] is True
    assert first["postgres_synced"] is False

    with patch("app.tools.delivery_tools.dual_write_delivery") as mock_dual_write:
        retried = create_delivery(
            sales_order_id="SO0001", customer_id="C001", customer_name="ABC Corp",
            product_id="P011", product_name="Wireless Mouse", quantity=1,
            idempotency_key=key,
        )

    assert retried["delivery_id"] == first["delivery_id"]  # same Excel row, never duplicated
    assert retried["postgres_synced"] is True
    mock_dual_write.assert_called_once()
