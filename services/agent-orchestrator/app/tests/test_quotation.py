# app/tests/test_quotation.py
import pytest

from app.agents.quotation_agent import quotation_agent


@pytest.mark.asyncio
async def test_quotation_agent_prices_in_stock_request():
    result = await quotation_agent(
        customer_name="ABC",
        product_name="Laptop",
        quantity=10,
        price=1000.0,
        stock_total=50,
        can_produce=True,
        lead_time_days=5,
    )

    assert result.quantity == 10
    assert result.quoted_price == 1000.0
    assert result.total_amount == 10000.0
    assert result.valid_for_days > 0
