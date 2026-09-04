# app/tests/test_delivery.py
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
