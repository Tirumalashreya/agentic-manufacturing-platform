# app/tests/test_credit.py
from app.tools.credit_tools import check_credit
from app.tools.sales_tools import create_sales_order


def test_check_credit_within_limit():
    result = check_credit(
        customer_id="C_TEST_CREDIT_ONE",
        credit_limit=1000000.0,
        new_order_amount=50000.0,
    )

    assert result["checked"] is True
    assert result["existing_exposure"] == 0
    assert result["total_exposure"] == 50000.0
    assert result["within_credit"] is True


def test_check_credit_over_limit():
    result = check_credit(
        customer_id="C_TEST_CREDIT_TWO",
        credit_limit=10000.0,
        new_order_amount=50000.0,
    )

    assert result["checked"] is True
    assert result["within_credit"] is False


def test_check_credit_missing_customer():
    result = check_credit(
        customer_id=None,
        credit_limit=100000.0,
        new_order_amount=50000.0,
    )

    assert result["checked"] is False


def test_check_credit_missing_limit():
    result = check_credit(
        customer_id="C001",
        credit_limit=None,
        new_order_amount=50000.0,
    )

    assert result["checked"] is False


def test_check_credit_includes_existing_orders_from_real_customer():
    # C001 (ABC Corp, credit_limit 100000) already has real Sales Orders on
    # record from earlier live testing this session — confirm existing
    # exposure is picked up, not just the new order in isolation.
    result = check_credit(
        customer_id="C001",
        credit_limit=100000.0,
        new_order_amount=1.0,
    )

    assert result["checked"] is True
    assert result["existing_exposure"] > 0


def test_check_credit_excludes_the_order_being_checked():
    # In the real graph flow (credit_check_node), the Sales Order being
    # checked has ALREADY been written to the SalesOrders sheet by
    # create_sales_order() before credit_check_node ever runs — so without
    # excluding it, its own total_amount gets summed once as "existing"
    # exposure and a second time via new_order_amount, silently doubling
    # its apparent exposure. exclude_sales_order_id fixes that.
    order = create_sales_order(
        customer_id="C001",
        customer_name="ABC Corp",
        customer_active=True,
        product_id="P011",
        product_name="Wireless Mouse",
        quantity=1,
        unit_price=800.0,
        requested_deadline=None,
    )

    baseline = check_credit(customer_id="C001", credit_limit=1_000_000.0, new_order_amount=0)

    without_exclusion = check_credit(
        customer_id="C001",
        credit_limit=1_000_000.0,
        new_order_amount=order["total_amount"],
    )
    assert without_exclusion["existing_exposure"] == baseline["existing_exposure"]
    assert without_exclusion["total_exposure"] == baseline["existing_exposure"] + order["total_amount"]

    with_exclusion = check_credit(
        customer_id="C001",
        credit_limit=1_000_000.0,
        new_order_amount=order["total_amount"],
        exclude_sales_order_id=order["sales_order_id"],
    )
    # The order's own amount is now counted exactly once, not twice.
    assert with_exclusion["existing_exposure"] == baseline["existing_exposure"] - order["total_amount"]
    assert with_exclusion["total_exposure"] == baseline["existing_exposure"]
