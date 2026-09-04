# app/tests/test_sales_order_status.py
from app.tools.sales_tools import create_sales_order, update_sales_order_status


def test_update_sales_order_status_updates_real_row():
    created = create_sales_order(
        customer_id="C001",
        customer_name="ABC Corp",
        customer_active=True,
        product_id="P011",
        product_name="Wireless Mouse",
        quantity=2,
        unit_price=800.0,
        requested_deadline=None,
    )

    result = update_sales_order_status(created["sales_order_id"], "CREDIT_BLOCKED")

    assert result["updated"] is True
    assert result["status"] == "CREDIT_BLOCKED"


def test_update_sales_order_status_unknown_id():
    result = update_sales_order_status("SO9999", "CREDIT_BLOCKED")

    assert result["updated"] is False
