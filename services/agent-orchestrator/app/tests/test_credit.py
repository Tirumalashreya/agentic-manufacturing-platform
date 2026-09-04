# app/tests/test_credit.py
from app.tools.credit_tools import check_credit


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
