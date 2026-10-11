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
