# app/tests/test_trading.py
import pytest

from app.tools.trading_tools import (
    create_trading_order,
    get_vendors_for_product,
    find_trading_order,
    update_trading_order_status,
    mark_trading_order_dispatched,
)
from app.tools.inventory_tools import get_stock
from app.tools.sales_tools import create_sales_order
from app.graph import dispatch_trading_order


def test_get_vendors_for_product_multiple_options():
    # Webcam HD (P016) deliberately has two vendors seeded, matching the
    # same cost/speed-tradeoff pattern used for component procurement.
    vendors = get_vendors_for_product("P016")

    assert len(vendors) == 2
    vendor_ids = {v["vendor_id"] for v in vendors}
    assert vendor_ids == {"PV001", "PV002"}


def test_get_vendors_for_product_single_option():
    vendors = get_vendors_for_product("P013")

    assert len(vendors) == 1
    assert vendors[0]["vendor_id"] == "PV003"


def test_get_vendors_for_product_no_vendor():
    vendors = get_vendors_for_product("P999_DOES_NOT_EXIST")

    assert vendors == []


def test_create_trading_order_succeeds():
    result = create_trading_order(
        sales_order_id="SO0001",
        product_id="P016",
        product_name="Webcam HD",
        vendor_id="PV002",
        vendor_name="QuickTech Supply",
        quantity=100,
        unit_cost=2400.0,
        lead_time_days=3,
    )

    assert result["created"] is True
    assert result["total_cost"] == 240000.0
    assert result["trading_order_id"].startswith("TO")


def test_create_trading_order_rejects_bad_quantity():
    result = create_trading_order(
        sales_order_id="SO0001",
        product_id="P016",
        product_name="Webcam HD",
        vendor_id="PV002",
        vendor_name="QuickTech Supply",
        quantity=0,
        unit_cost=2400.0,
        lead_time_days=3,
    )

    assert result["created"] is False


def _new_trading_order(quantity=100):
    return create_trading_order(
        sales_order_id="SO0001",
        product_id="P016",
        product_name="Webcam HD",
        vendor_id="PV002",
        vendor_name="QuickTech Supply",
        quantity=quantity,
        unit_cost=2400.0,
        lead_time_days=3,
    )


def test_trading_order_status_progresses_to_warehoused_and_credits_inventory():
    before = {row["plant"]: row["stock_qty"] for row in get_stock("P016")}

    order = _new_trading_order(quantity=50)
    tid = order["trading_order_id"]

    assert update_trading_order_status(tid, "RECEIVED")["updated"] is True
    assert update_trading_order_status(tid, "QC_PASSED")["updated"] is True
    result = update_trading_order_status(tid, "WAREHOUSED")
    assert result["updated"] is True

    after = {row["plant"]: row["stock_qty"] for row in get_stock("P016")}
    total_before = sum(before.values())
    total_after = sum(after.values())
    assert total_after == total_before + 50

    assert find_trading_order(tid)["status"] == "WAREHOUSED"


def test_trading_order_qc_failed_is_terminal_and_credits_nothing():
    before = {row["plant"]: row["stock_qty"] for row in get_stock("P016")}

    order = _new_trading_order(quantity=30)
    tid = order["trading_order_id"]

    update_trading_order_status(tid, "RECEIVED")
    result = update_trading_order_status(tid, "QC_FAILED")
    assert result["updated"] is True

    # No further transition allowed out of QC_FAILED.
    next_attempt = update_trading_order_status(tid, "WAREHOUSED")
    assert next_attempt["updated"] is False

    after = {row["plant"]: row["stock_qty"] for row in get_stock("P016")}
    assert sum(after.values()) == sum(before.values())


def test_trading_order_status_rejects_skipping_a_stage():
    order = _new_trading_order()
    tid = order["trading_order_id"]

    result = update_trading_order_status(tid, "WAREHOUSED")

    assert result["updated"] is False


def test_mark_trading_order_dispatched_requires_warehoused():
    order = _new_trading_order()
    tid = order["trading_order_id"]

    result = mark_trading_order_dispatched(tid)

    assert result["updated"] is False


@pytest.mark.asyncio
async def test_dispatch_trading_order_delivers_and_bills():
    sales_order = create_sales_order(
        customer_id="C001",
        customer_name="ABC Corp",
        customer_active=True,
        product_id="P016",
        product_name="Webcam HD",
        quantity=25,
        unit_price=3000.0,
        requested_deadline=None,
    )

    order = create_trading_order(
        sales_order_id=sales_order["sales_order_id"],
        product_id="P016",
        product_name="Webcam HD",
        vendor_id="PV002",
        vendor_name="QuickTech Supply",
        quantity=25,
        unit_cost=2400.0,
        lead_time_days=3,
    )
    tid = order["trading_order_id"]
    update_trading_order_status(tid, "RECEIVED")
    update_trading_order_status(tid, "QC_PASSED")
    update_trading_order_status(tid, "WAREHOUSED")

    result = await dispatch_trading_order(tid)

    assert result["dispatched"] is True
    assert result["delivery_id"] is not None
    assert result["invoice_id"] is not None
    assert find_trading_order(tid)["status"] == "DISPATCHED"


@pytest.mark.asyncio
async def test_dispatch_trading_order_rejects_not_warehoused():
    order = _new_trading_order()

    result = await dispatch_trading_order(order["trading_order_id"])

    assert result["dispatched"] is False
