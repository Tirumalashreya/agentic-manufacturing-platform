# app/tests/test_consignment.py
import pytest

from app.agents.consignment_agent import consignment_agent
from app.tools.consignment_tools import (
    close_consignment,
    create_consignment,
    find_consignment,
    list_consignments,
    list_open_consignments,
    report_consignment_sale,
    return_unsold_consignment_stock,
)
from app.tools.inventory_tools import get_stock


@pytest.mark.asyncio
async def test_consignment_agent_extracts_notes():
    result = await consignment_agent(
        "Send 50 units to our distributor to sell on consignment, 90-day sell-through window."
    )

    assert len(result.notes) > 0


def _new_consignment(quantity_sent=5, unit_price=800.0):
    return create_consignment(
        customer_id="C001",
        customer_name="ABC Corp",
        product_id="P011",
        product_name="Wireless Mouse",
        quantity_sent=quantity_sent,
        unit_price=unit_price,
        notes="90-day sell-through window.",
    )


def test_create_consignment_transfers_stock_without_invoicing():
    before = sum(row["stock_qty"] for row in get_stock("P011"))

    result = _new_consignment(quantity_sent=5)

    assert result["created"] is True
    assert result["consignment_id"].startswith("CNG")
    assert result["status"] == "ACTIVE"

    after = sum(row["stock_qty"] for row in get_stock("P011"))
    assert after == before - 5

    consignment = find_consignment(result["consignment_id"])
    assert consignment["quantity_sold"] == 0
    assert consignment["quantity_remaining"] == 5


def test_create_consignment_rejects_bad_quantity():
    result = _new_consignment(quantity_sent=0)

    assert result["created"] is False


def test_report_consignment_sale_invoices_only_sold_quantity():
    created = _new_consignment(quantity_sent=10, unit_price=800.0)

    result = report_consignment_sale(created["consignment_id"], 3)

    assert result["reported"] is True
    assert result["invoice_id"] is not None
    assert result["invoice_id"].startswith("INV")
    assert result["quantity_remaining"] == 7

    consignment = find_consignment(created["consignment_id"])
    assert consignment["quantity_sold"] == 3


def test_report_consignment_sale_rejects_exceeding_sent_quantity():
    created = _new_consignment(quantity_sent=5)
    report_consignment_sale(created["consignment_id"], 3)

    result = report_consignment_sale(created["consignment_id"], 3)

    assert result["reported"] is False
    assert "already settled" in result["reason"]


def test_return_unsold_consignment_stock_credits_inventory():
    created = _new_consignment(quantity_sent=10)
    report_consignment_sale(created["consignment_id"], 4)
    before = sum(row["stock_qty"] for row in get_stock("P011"))

    result = return_unsold_consignment_stock(created["consignment_id"], 6)

    assert result["returned"] is True
    assert result["quantity_remaining"] == 0

    after = sum(row["stock_qty"] for row in get_stock("P011"))
    assert after == before + 6


def test_return_unsold_consignment_stock_rejects_exceeding_remaining():
    created = _new_consignment(quantity_sent=5)
    report_consignment_sale(created["consignment_id"], 3)

    result = return_unsold_consignment_stock(created["consignment_id"], 3)

    assert result["returned"] is False


def test_close_consignment_requires_fully_settled():
    created = _new_consignment(quantity_sent=5)

    result = close_consignment(created["consignment_id"])

    assert result["closed"] is False


def test_close_consignment_succeeds_once_fully_sold():
    created = _new_consignment(quantity_sent=5)
    report_consignment_sale(created["consignment_id"], 5)

    result = close_consignment(created["consignment_id"])

    assert result["closed"] is True
    assert find_consignment(created["consignment_id"])["status"] == "CLOSED"


def test_close_consignment_succeeds_with_mixed_sale_and_return():
    created = _new_consignment(quantity_sent=10)
    report_consignment_sale(created["consignment_id"], 6)
    return_unsold_consignment_stock(created["consignment_id"], 4)

    result = close_consignment(created["consignment_id"])

    assert result["closed"] is True


def test_find_consignment_unknown_id():
    assert find_consignment("CNG9999") is None


def test_list_consignments_includes_closed_newest_first():
    created = _new_consignment(quantity_sent=5)
    report_consignment_sale(created["consignment_id"], 5)
    close_consignment(created["consignment_id"])

    consignments = list_consignments()

    assert consignments[0]["consignment_id"] == created["consignment_id"]
    assert consignments[0]["status"] == "CLOSED"


def test_list_open_consignments_excludes_closed():
    open_consignment = _new_consignment(quantity_sent=5)
    to_close = _new_consignment(quantity_sent=5)
    report_consignment_sale(to_close["consignment_id"], 5)
    close_consignment(to_close["consignment_id"])

    ids = {row["consignment_id"] for row in list_open_consignments()}

    assert open_consignment["consignment_id"] in ids
    assert to_close["consignment_id"] not in ids
