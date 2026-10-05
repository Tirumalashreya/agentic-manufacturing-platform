# app/tests/test_configuration.py
import pytest

from app.agents.configuration_agent import configuration_agent


@pytest.mark.asyncio
async def test_configuration_agent_extracts_stated_options():
    result = await configuration_agent(
        product_name="Laptop - Standard",
        user_message="I want 50 laptops with 32GB RAM, 1TB SSD and an i7 processor.",
    )

    attributes = {opt.attribute.lower() for opt in result.options}
    assert len(result.options) >= 2
    assert any("ram" in a for a in attributes) or any("processor" in a for a in attributes)


@pytest.mark.asyncio
async def test_configuration_agent_no_options_stated():
    result = await configuration_agent(
        product_name="Laptop - Standard",
        user_message="ABC Corp wants to order 3 laptops now.",
    )

    assert result.options == []
