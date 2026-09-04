# app/tests/test_production_tools.py
import openpyxl

from app.tools.production_tools import (
    MOCK_ERP_PATH,
    create_production_order,
    reserve_stock,
)


def _inventory_qty(product_id: str, plant: str) -> int:
    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    sheet = wb["Inventory"]
    for row in sheet.iter_rows(min_row=2, values_only=True):
        if row[0] == product_id and row[1] == plant:
            return row[2]
    raise AssertionError(f"No inventory row for {product_id}/{plant}")


def test_create_production_order_succeeds():
    result = create_production_order(
        sales_order_id="SO0001",
        product_id="P002",
        product_name="Laptop - Gaming",
        quantity=10,
        lead_time_days=25,
    )

    assert result["created"] is True
    assert result["production_order_id"].startswith("PO")
    assert result["status"] == "PLANNED"


def test_create_production_order_rejects_bad_quantity():
    result = create_production_order(
        sales_order_id="SO0001",
        product_id="P002",
        product_name="Laptop - Gaming",
        quantity=0,
        lead_time_days=25,
    )

    assert result["created"] is False


def test_create_production_order_marks_configuration_required():
    result = create_production_order(
        sales_order_id="SO0001",
        product_id="P001",
        product_name="Laptop - Standard",
        quantity=5,
        lead_time_days=20,
        requires_configuration=True,
        configuration_notes="Configuration Agent not yet built.",
    )

    assert result["created"] is True


def test_reserve_stock_decrements_real_inventory():
    before = _inventory_qty("P011", "PLANT01")

    result = reserve_stock(
        sales_order_id="SO0002",
        product_id="P011",
        product_name="Wireless Mouse",
        quantity=3,
    )

    assert result["reserved"] is True
    assert sum(a["quantity"] for a in result["allocations"]) == 3

    after = _inventory_qty("P011", "PLANT01")
    assert before - after == 3


def test_reserve_stock_rejects_insufficient_stock():
    # P002 (Laptop - Gaming) has zero stock at both plants in the seed data.
    result = reserve_stock(
        sales_order_id="SO0003",
        product_id="P002",
        product_name="Laptop - Gaming",
        quantity=1,
    )

    assert result["reserved"] is False


def test_reserve_stock_rejects_bad_quantity():
    result = reserve_stock(
        sales_order_id="SO0004",
        product_id="P011",
        product_name="Wireless Mouse",
        quantity=0,
    )

    assert result["reserved"] is False
