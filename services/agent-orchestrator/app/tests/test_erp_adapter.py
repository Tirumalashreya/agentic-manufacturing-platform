# app/tests/test_erp_adapter.py
from app.erp.mock_erp_adapter import MockERPAdapter
from app.tools.customer_tools import get_customer
from app.tools.product_tools import get_product
from app.tools.sales_tools import create_sales_order

erp = MockERPAdapter()


def test_get_customer_matches_direct_tool_call():
    assert erp.get_customer("ABC Corp") == get_customer("ABC Corp")


def test_get_product_matches_direct_tool_call():
    assert erp.get_product("Wireless Mouse") == get_product("Wireless Mouse")


def test_get_product_handles_none_name():
    assert erp.get_product(None) is None


def test_check_credit_matches_direct_tool_call():
    from app.tools.credit_tools import check_credit

    direct = check_credit("C001", 1_000_000.0, 5000.0)
    via_adapter = erp.check_credit("C001", 1_000_000.0, 5000.0)

    assert direct["existing_exposure"] == via_adapter["existing_exposure"]
    assert direct["total_exposure"] == via_adapter["total_exposure"]


def test_create_sales_order_via_adapter_creates_a_real_order():
    result = erp.create_sales_order(
        customer_id="C001",
        customer_name="ABC Corp",
        customer_active=True,
        product_id="P011",
        product_name="Wireless Mouse",
        quantity=1,
        unit_price=800.0,
        requested_deadline=None,
    )

    assert result["created"] is True
    assert result["sales_order_id"].startswith("SO")


def test_create_sales_order_via_adapter_respects_idempotency_key():
    key = "erp-adapter-idempotency-test"

    first = erp.create_sales_order(
        customer_id="C001", customer_name="ABC Corp", customer_active=True,
        product_id="P011", product_name="Wireless Mouse",
        quantity=1, unit_price=800.0, requested_deadline=None,
        idempotency_key=key,
    )
    second = erp.create_sales_order(
        customer_id="C001", customer_name="ABC Corp", customer_active=True,
        product_id="P011", product_name="Wireless Mouse",
        quantity=1, unit_price=800.0, requested_deadline=None,
        idempotency_key=key,
    )

    assert second["sales_order_id"] == first["sales_order_id"]


def test_erp_adapter_is_a_concrete_erpadapter():
    from app.erp.interface import ERPAdapter

    assert isinstance(erp, ERPAdapter)
