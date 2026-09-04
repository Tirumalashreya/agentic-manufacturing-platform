# app/tests/test_sales_order.py
from app.tools.sales_tools import create_sales_order


def test_create_sales_order_succeeds_for_active_customer():
    result = create_sales_order(
        customer_id="C001",
        customer_name="ABC Corp",
        customer_active=True,
        product_id="P001",
        product_name="Laptop - Standard",
        quantity=10,
        unit_price=50000.0,
        requested_deadline="next month",
    )

    assert result["created"] is True
    assert result["status"] == "CONFIRMED"
    assert result["total_amount"] == 500000.0
    assert result["sales_order_id"].startswith("SO")


def test_create_sales_order_rejects_unknown_customer():
    result = create_sales_order(
        customer_id=None,
        customer_name=None,
        customer_active=False,
        product_id="P001",
        product_name="Laptop - Standard",
        quantity=10,
        unit_price=50000.0,
        requested_deadline=None,
    )

    assert result["created"] is False


def test_create_sales_order_rejects_inactive_customer():
    result = create_sales_order(
        customer_id="C007",
        customer_name="Blue Ocean Traders",
        customer_active=False,
        product_id="P001",
        product_name="Laptop - Standard",
        quantity=10,
        unit_price=50000.0,
        requested_deadline=None,
    )

    assert result["created"] is False


def test_create_sales_order_rejects_missing_product():
    result = create_sales_order(
        customer_id="C001",
        customer_name="ABC Corp",
        customer_active=True,
        product_id=None,
        product_name=None,
        quantity=10,
        unit_price=None,
        requested_deadline=None,
    )

    assert result["created"] is False


def test_create_sales_order_rejects_invalid_quantity():
    result = create_sales_order(
        customer_id="C001",
        customer_name="ABC Corp",
        customer_active=True,
        product_id="P001",
        product_name="Laptop - Standard",
        quantity=0,
        unit_price=50000.0,
        requested_deadline=None,
    )

    assert result["created"] is False
