# app/tests/test_fulfillment.py
import pytest

from app.agents.fulfillment_agent import fulfillment_agent


@pytest.mark.asyncio
async def test_full_stock_is_mts():
    result = await fulfillment_agent(
        product_name="Wireless Mouse",
        quantity=20,
        stock_total=100,
        can_produce=True,
        product_configurable=False,
        lead_time_days=5,
    )

    assert result.strategy == "MTS"


@pytest.mark.asyncio
async def test_zero_stock_producible_is_mto():
    result = await fulfillment_agent(
        product_name="Server - Blade",
        quantity=10,
        stock_total=0,
        can_produce=True,
        product_configurable=False,
        lead_time_days=30,
    )

    assert result.strategy == "MTO"


@pytest.mark.asyncio
async def test_partial_stock_producible_is_hybrid():
    result = await fulfillment_agent(
        product_name="Laptop - Standard",
        quantity=100,
        stock_total=40,
        can_produce=True,
        product_configurable=False,
        lead_time_days=20,
    )

    assert result.strategy == "HYBRID"


@pytest.mark.asyncio
async def test_configurable_product_is_cto():
    result = await fulfillment_agent(
        product_name="Server Rack Unit",
        quantity=5,
        stock_total=50,
        can_produce=True,
        product_configurable=True,
        lead_time_days=15,
    )

    assert result.strategy == "CTO"


@pytest.mark.asyncio
async def test_no_stock_cannot_produce_is_third_party():
    result = await fulfillment_agent(
        product_name="Printer - Laser",
        quantity=3,
        stock_total=0,
        can_produce=False,
        product_configurable=False,
        lead_time_days=None,
    )

    assert result.strategy == "THIRD_PARTY"
