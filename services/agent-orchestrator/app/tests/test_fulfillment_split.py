# app/tests/test_fulfillment_split.py
from app.tools.fulfillment_tools import compute_fulfillment_split


def test_mts_takes_everything_from_stock():
    result = compute_fulfillment_split("MTS", quantity=20, stock_total=100)

    assert result == {"from_stock": 20, "to_produce": 0}


def test_mto_produces_everything():
    result = compute_fulfillment_split("MTO", quantity=10, stock_total=0)

    assert result == {"from_stock": 0, "to_produce": 10}


def test_hybrid_splits_between_stock_and_production():
    result = compute_fulfillment_split("HYBRID", quantity=100, stock_total=40)

    assert result == {"from_stock": 40, "to_produce": 60}


def test_hybrid_clamps_to_available_stock():
    # stock_total exceeding quantity shouldn't happen for a real HYBRID
    # decision, but the math should still be safe if it does.
    result = compute_fulfillment_split("HYBRID", quantity=10, stock_total=999)

    assert result == {"from_stock": 10, "to_produce": 0}


def test_cto_does_not_pull_from_stock():
    result = compute_fulfillment_split("CTO", quantity=5, stock_total=50)

    assert result == {"from_stock": 0, "to_produce": 5}


def test_third_party_does_not_pull_from_stock():
    result = compute_fulfillment_split("THIRD_PARTY", quantity=3, stock_total=0)

    assert result == {"from_stock": 0, "to_produce": 3}
