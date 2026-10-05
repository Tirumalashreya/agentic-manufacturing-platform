# app/tests/test_process.py
import pytest

from app.agents.process_agent import process_agent


@pytest.mark.asyncio
async def test_process_agent_request_quote_is_pre_sales():
    result = await process_agent(
        intent="request_quote",
        customer="ABC",
        product="laptops",
        quantity=100,
        requested_deadline="next month",
        customer_exists=True,
        customer_active=True,
        product_valid=True,
    )

    assert result.entry_type == "PRE_SALES"
    assert result.process == "QUOTE_REQUEST"


@pytest.mark.asyncio
async def test_process_agent_create_order_is_direct_sales():
    result = await process_agent(
        intent="create_order",
        customer="ABC",
        product="laptops",
        quantity=100,
        requested_deadline="next month",
        customer_exists=True,
        customer_active=True,
        product_valid=True,
    )

    assert result.entry_type == "DIRECT_SALES"
    assert result.process == "NEW_SALES_ORDER"
