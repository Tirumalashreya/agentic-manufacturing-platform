# app/tests/test_export.py
import asyncio

import pytest

from app.agents.export_agent import export_agent
from app.graph import allocate_or_produce_export_order
from app.tools.export_tools import (
    close_export_order,
    create_export_order,
    find_export_order,
    invoice_export_order,
    list_export_orders,
    list_open_export_orders,
    record_documentation,
    record_freight_booking,
    ship_export_order,
    verify_export_payment,
)
from app.tools.inventory_tools import get_stock


@pytest.mark.asyncio
async def test_export_agent_extracts_destination_and_incoterm():
    result = await export_agent(
        "We want to export 200 units to our distributor in Germany, terms FOB."
    )

    assert result.destination_country is not None
    assert "german" in result.destination_country.lower()
    assert result.incoterm is not None
    assert "fob" in result.incoterm.lower()


@pytest.mark.asyncio
async def test_export_agent_never_invents_destination():
    result = await export_agent("We'd like to place a large order, shipping details TBD.")

    assert result.destination_country is None


def _new_export_order(quantity=10, unit_price=1000.0, destination_country="Germany", incoterm="FOB"):
    return create_export_order(
        customer_id="C001",
        customer_name="ABC Corp",
        product_id="P011",
        product_name="Wireless Mouse",
        quantity=quantity,
        unit_price=unit_price,
        destination_country=destination_country,
        incoterm=incoterm,
    )


def test_create_export_order_issues_proforma_invoice():
    result = _new_export_order(quantity=10, unit_price=800.0)

    assert result["created"] is True
    assert result["export_order_id"].startswith("EXP")
    assert result["total_value"] == 8000.0
    assert result["proforma_invoice_id"] is not None
    assert result["proforma_invoice_id"].startswith("INV")
    assert result["status"] == "CONFIRMED"


def test_create_export_order_rejects_missing_destination():
    result = create_export_order(
        customer_id="C001",
        customer_name="ABC Corp",
        product_id="P011",
        product_name="Wireless Mouse",
        quantity=10,
        unit_price=800.0,
        destination_country=None,
        incoterm=None,
    )

    assert result["created"] is False


def test_create_export_order_rejects_bad_quantity():
    result = _new_export_order(quantity=0)

    assert result["created"] is False


def test_verify_export_payment_requires_real_reference():
    order = _new_export_order()

    result = verify_export_payment(order["export_order_id"], "")

    assert result["updated"] is False


def test_verify_export_payment_succeeds_with_reference():
    order = _new_export_order()

    result = verify_export_payment(order["export_order_id"], "LC-REF-001")

    assert result["updated"] is True
    assert result["status"] == "PAYMENT_VERIFIED"


def test_verify_export_payment_rejects_wrong_starting_status():
    order = _new_export_order()
    verify_export_payment(order["export_order_id"], "LC-REF-001")

    second = verify_export_payment(order["export_order_id"], "LC-REF-002")

    assert second["updated"] is False


@pytest.mark.asyncio
async def test_allocate_or_produce_requires_payment_verified():
    order = _new_export_order()

    result = await allocate_or_produce_export_order(order["export_order_id"])

    assert result["allocated"] is False


@pytest.mark.asyncio
async def test_allocate_from_stock_when_available():
    # Wireless Mouse has plenty of real stock — a small quantity should
    # allocate from stock rather than triggering production.
    order = _new_export_order(quantity=2)
    verify_export_payment(order["export_order_id"], "LC-REF-001")

    result = await allocate_or_produce_export_order(order["export_order_id"])

    assert result["allocated"] is True
    assert result["status"] == "ALLOCATED"
    assert find_export_order(order["export_order_id"])["reservation_id"] is not None


# Independent-audit fix: allocate_or_produce_export_order is "an
# operational trigger, not part of the chat graph" (its own doc comment)
# — retriable by its caller, same as dispatch_trading_order. Two
# concurrent calls on the same still-PAYMENT_VERIFIED order used to both
# read the order as not-yet-allocated and both reserve real stock before
# either wrote ALLOCATED back, double-reserving (and double-decrementing)
# Inventory for one logical allocation. reserve_stock is now called with
# a stable idempotency_key derived from export_order_id, so the second
# concurrent call replays the first's cached reservation instead of
# taking a second real one.
#
# Real OS threads, not asyncio.gather: the stock-sufficient branch this
# exercises has no await before reserve_stock's own blocking flock I/O,
# so two gathered coroutines on one event loop would just run back-to-
# back with no actual overlap — exactly the same reason test_trading.py's
# own concurrency tests use threading.Thread, each running its own event
# loop via asyncio.run, to get a genuine race on the real flock.
def test_allocate_concurrent_same_export_order_reserves_stock_exactly_once():
    import threading

    before = {row["plant"]: row["stock_qty"] for row in get_stock("P011")}
    order = _new_export_order(quantity=3)
    verify_export_payment(order["export_order_id"], "LC-REF-001")

    results: list[dict] = []

    def call():
        results.append(asyncio.run(allocate_or_produce_export_order(order["export_order_id"])))

    threads = [threading.Thread(target=call) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    succeeded = [r for r in results if r["allocated"]]
    assert len(succeeded) >= 1, f"expected at least one real allocation, got: {results}"

    # The real proof regardless of exact thread timing (both may win the
    # race and both report allocated=True via the replayed cache, or the
    # second may simply lose to the order's own status guard) — real
    # Inventory must never be decremented more than once for one logical
    # allocation.
    after = {row["plant"]: row["stock_qty"] for row in get_stock("P011")}
    assert sum(before.values()) - sum(after.values()) == 3  # reserved exactly once, not twice


async def _advance_to_shipped(export_order_id: str) -> None:
    verify_export_payment(export_order_id, "LC-REF-001")
    await allocate_or_produce_export_order(export_order_id)
    record_documentation(export_order_id, "CUSTOMS-DECL-001")
    record_freight_booking(export_order_id, "FREIGHT-BOOK-001")
    ship_export_order(export_order_id, "BL-AWB-001")


def test_record_documentation_requires_allocation_first():
    order = _new_export_order()

    result = record_documentation(order["export_order_id"], "CUSTOMS-DECL-001")

    assert result["updated"] is False


@pytest.mark.asyncio
async def test_full_export_pipeline_ships_invoices_and_closes():
    order = _new_export_order(quantity=2, unit_price=800.0)
    export_order_id = order["export_order_id"]

    await _advance_to_shipped(export_order_id)

    shipped = find_export_order(export_order_id)
    assert shipped["status"] == "SHIPPED"
    assert shipped["delivery_id"] is not None

    invoiced = invoice_export_order(export_order_id)
    assert invoiced["updated"] is True
    assert invoiced["export_invoice_id"] is not None
    assert invoiced["export_invoice_id"] != order["proforma_invoice_id"]

    closed = close_export_order(export_order_id)
    assert closed["closed"] is True
    assert closed["status"] == "CLOSED"


@pytest.mark.asyncio
async def test_close_export_order_requires_invoiced():
    order = _new_export_order(quantity=2)
    await _advance_to_shipped(order["export_order_id"])

    result = close_export_order(order["export_order_id"])

    assert result["closed"] is False


def test_ship_export_order_requires_real_bl_awb_number():
    order = _new_export_order()

    result = ship_export_order(order["export_order_id"], "")

    assert result["updated"] is False


def test_find_export_order_unknown_id():
    assert find_export_order("EXP9999") is None


def test_list_export_orders_includes_closed_newest_first():
    order = _new_export_order()

    orders = list_export_orders()

    assert orders[0]["export_order_id"] == order["export_order_id"]


@pytest.mark.asyncio
async def test_list_open_export_orders_excludes_closed():
    open_order = _new_export_order()
    to_close = _new_export_order()
    await _advance_to_shipped(to_close["export_order_id"])
    invoice_export_order(to_close["export_order_id"])
    close_export_order(to_close["export_order_id"])

    ids = {row["export_order_id"] for row in list_open_export_orders()}

    assert open_order["export_order_id"] in ids
    assert to_close["export_order_id"] not in ids


# Independent-audit fix: ship_export_order/invoice_export_order/
# create_export_order called create_delivery/create_invoice without an
# idempotency_key, so the protection those two functions already have
# never actually engaged for the export channel — a double-submitted
# "ship" or "invoice" chat action could create two real Deliveries/
# Invoices. Each export function's own status-machine gate (e.g.
# ship_export_order requires FREIGHT_BOOKED) already prevents calling it
# a second time sequentially once the first succeeded, so proving the
# wiring means reproducing the exact key each function now constructs
# and confirming create_delivery/create_invoice treat it as a real
# replay — the same key a genuine concurrent/retried call would carry.
from app.erp.mock_erp_adapter import default_erp_adapter as _erp


@pytest.mark.asyncio
async def test_ship_export_order_delivery_key_is_wired_and_prevents_a_duplicate_real_delivery():
    order = _new_export_order(quantity=2, unit_price=800.0)
    export_order_id = order["export_order_id"]
    await _advance_to_shipped(export_order_id)
    real_delivery_id = find_export_order(export_order_id)["delivery_id"]

    # The exact key ship_export_order constructs internally — a genuine
    # retry of the same shipment action would carry this same key.
    replay = _erp.create_delivery(
        sales_order_id=None, customer_id="C001",
        customer_name="ABC Corp", product_id="P011", product_name="Wireless Mouse",
        quantity=2, idempotency_key=f"export-ship-{export_order_id}",
    )
    assert replay["delivery_id"] == real_delivery_id  # replayed, not a second real delivery


@pytest.mark.asyncio
async def test_invoice_export_order_invoice_key_is_wired_and_prevents_a_duplicate_real_invoice():
    order = _new_export_order(quantity=2, unit_price=800.0)
    export_order_id = order["export_order_id"]
    await _advance_to_shipped(export_order_id)
    real = invoice_export_order(export_order_id)
    assert real["updated"] is True

    replay = _erp.create_invoice(
        sales_order_id=None, delivery_id=find_export_order(export_order_id)["delivery_id"],
        customer_id="C001", customer_name="ABC Corp",
        quantity_billed=2, unit_price=800.0, payment_terms_days=30, notes="replay",
        idempotency_key=f"export-commercial-invoice-{export_order_id}",
    )
    assert replay["invoice_id"] == real["export_invoice_id"]  # replayed, not a second real invoice


def test_create_export_order_proforma_invoice_key_is_wired_and_prevents_a_duplicate_real_invoice():
    order = _new_export_order(quantity=5, unit_price=800.0)

    replay = _erp.create_invoice(
        sales_order_id=None, delivery_id=None, customer_id="C001", customer_name="ABC Corp",
        quantity_billed=5, unit_price=800.0, payment_terms_days=30, notes="replay",
        idempotency_key=f"export-proforma-invoice-{order['export_order_id']}",
    )
    assert replay["invoice_id"] == order["proforma_invoice_id"]
