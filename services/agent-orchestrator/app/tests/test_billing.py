# app/tests/test_billing.py
import pytest

from app.agents.billing_agent import billing_agent
from app.tools.billing_tools import create_invoice


@pytest.mark.asyncio
async def test_billing_agent_full_delivery():
    result = await billing_agent(
        quantity_delivered=10,
        quantity_ordered=10,
        unit_price=800.0,
    )

    assert result.payment_terms_days > 0


@pytest.mark.asyncio
async def test_billing_agent_partial_delivery_notes_it():
    result = await billing_agent(
        quantity_delivered=40,
        quantity_ordered=100,
        unit_price=50000.0,
    )

    assert "partial" in result.notes.lower() or "remain" in result.notes.lower()


def test_create_invoice_succeeds():
    result = create_invoice(
        sales_order_id="SO0001",
        delivery_id="DEL0001",
        customer_id="C001",
        customer_name="ABC Corp",
        quantity_billed=5,
        unit_price=800.0,
        payment_terms_days=30,
        notes="Full delivery.",
    )

    assert result["created"] is True
    assert result["invoice_amount"] == 4000.0
    assert result["invoice_id"].startswith("INV")


def test_create_invoice_rejects_bad_quantity():
    result = create_invoice(
        sales_order_id="SO0001",
        delivery_id="DEL0001",
        customer_id="C001",
        customer_name="ABC Corp",
        quantity_billed=0,
        unit_price=800.0,
        payment_terms_days=30,
        notes="",
    )

    assert result["created"] is False
