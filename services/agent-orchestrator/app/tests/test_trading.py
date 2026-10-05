# app/tests/test_trading.py
import pytest

from app.tools.trading_tools import (
    create_trading_order,
    get_vendors_for_product,
    find_trading_order,
    list_open_trading_orders,
    list_trading_orders,
    update_trading_order_status,
    mark_trading_order_dispatched,
    mark_trading_order_delivered,
)
from app.tools.inventory_tools import get_stock
from app.tools.sales_tools import create_sales_order
from app.graph import deliver_drop_ship_order, dispatch_trading_order


def test_get_vendors_for_product_multiple_options():
    # Webcam HD (P016) deliberately has two vendors seeded, matching the
    # same cost/speed-tradeoff pattern used for component procurement —
    # and, deliberately, one of each route: PV001 doesn't ship direct
    # (warehouse/Trading route), PV002 does (drop-ship/Third-Party route).
    vendors = get_vendors_for_product("P016")

    assert len(vendors) == 2
    by_id = {v["vendor_id"]: v for v in vendors}
    assert set(by_id) == {"PV001", "PV002"}
    assert by_id["PV001"]["ships_direct_to_customer"] is False
    assert by_id["PV002"]["ships_direct_to_customer"] is True


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


def test_list_trading_orders_includes_new_order_newest_first():
    order = _new_trading_order()

    orders = list_trading_orders()

    assert orders[0]["trading_order_id"] == order["trading_order_id"]


def test_list_open_trading_orders_excludes_dispatched_and_qc_failed():
    ordered = _new_trading_order()

    qc_failed = _new_trading_order()
    update_trading_order_status(qc_failed["trading_order_id"], "RECEIVED")
    update_trading_order_status(qc_failed["trading_order_id"], "QC_FAILED")

    warehoused = _new_trading_order()
    update_trading_order_status(warehoused["trading_order_id"], "RECEIVED")
    update_trading_order_status(warehoused["trading_order_id"], "QC_PASSED")
    update_trading_order_status(warehoused["trading_order_id"], "WAREHOUSED")
    mark_trading_order_dispatched(warehoused["trading_order_id"])

    ids = {row["trading_order_id"] for row in list_open_trading_orders()}

    assert ordered["trading_order_id"] in ids
    assert qc_failed["trading_order_id"] not in ids
    assert warehoused["trading_order_id"] not in ids


# ---- Drop-ship (true Third-Party) route — separate lifecycle from the
# warehouse/Trading route above: ORDERED -> SHIPPED -> DELIVERED, never
# RECEIVED/QC/WAREHOUSED, never credits our own inventory. ----


def _new_drop_ship_order(quantity=10):
    return create_trading_order(
        sales_order_id="SO0001",
        product_id="P016",
        product_name="Webcam HD",
        vendor_id="PV002",
        vendor_name="QuickTech Supply",
        quantity=quantity,
        unit_cost=2400.0,
        lead_time_days=3,
        drop_ship=True,
    )


def test_create_trading_order_stores_drop_ship_flag():
    order = _new_drop_ship_order()

    assert order["drop_ship"] is True
    assert find_trading_order(order["trading_order_id"])["drop_ship"] is True


def test_drop_ship_order_can_go_ordered_to_shipped_to_delivered():
    before = {row["plant"]: row["stock_qty"] for row in get_stock("P016")}

    order = _new_drop_ship_order(quantity=10)
    tid = order["trading_order_id"]

    result = update_trading_order_status(tid, "SHIPPED")
    assert result["updated"] is True
    assert find_trading_order(tid)["status"] == "SHIPPED"

    # Never credited — the vendor shipped this straight to the customer,
    # it never touched our inventory at any point.
    after = {row["plant"]: row["stock_qty"] for row in get_stock("P016")}
    assert after == before


def test_drop_ship_order_cannot_enter_the_warehouse_route():
    order = _new_drop_ship_order()
    tid = order["trading_order_id"]

    result = update_trading_order_status(tid, "RECEIVED")

    assert result["updated"] is False
    assert "drop-ship" in result["reason"].lower()


def test_warehouse_route_order_cannot_be_marked_shipped():
    # The inverse guard: a normal (non-drop-ship) order can't skip into
    # the drop-ship lifecycle either.
    order = _new_trading_order()
    tid = order["trading_order_id"]

    result = update_trading_order_status(tid, "SHIPPED")

    assert result["updated"] is False


def test_mark_trading_order_delivered_requires_shipped():
    order = _new_drop_ship_order()

    result = mark_trading_order_delivered(order["trading_order_id"])

    assert result["updated"] is False


@pytest.mark.asyncio
async def test_deliver_drop_ship_order_delivers_and_bills_without_crediting_inventory():
    before = {row["plant"]: row["stock_qty"] for row in get_stock("P016")}

    sales_order = create_sales_order(
        customer_id="C001",
        customer_name="ABC Corp",
        customer_active=True,
        product_id="P016",
        product_name="Webcam HD",
        quantity=10,
        unit_price=3000.0,
        requested_deadline=None,
    )

    order = create_trading_order(
        sales_order_id=sales_order["sales_order_id"],
        product_id="P016",
        product_name="Webcam HD",
        vendor_id="PV002",
        vendor_name="QuickTech Supply",
        quantity=10,
        unit_cost=2400.0,
        lead_time_days=3,
        drop_ship=True,
    )
    tid = order["trading_order_id"]
    update_trading_order_status(tid, "SHIPPED")

    result = await deliver_drop_ship_order(tid)

    assert result["dispatched"] is True
    assert result["delivery_id"] is not None
    assert result["invoice_id"] is not None
    assert find_trading_order(tid)["status"] == "DELIVERED"

    after = {row["plant"]: row["stock_qty"] for row in get_stock("P016")}
    assert after == before


@pytest.mark.asyncio
async def test_deliver_drop_ship_order_rejects_not_shipped():
    order = _new_drop_ship_order()

    result = await deliver_drop_ship_order(order["trading_order_id"])

    assert result["dispatched"] is False
