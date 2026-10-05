# app/tests/test_reference_extraction.py
"""
Phase 2 step 1 evaluation set (agreed with the user): tests
request_understanding_agent IN ISOLATION — not the full graph — on
whether it can produce a reliable *reference structure* for implicit
entity references. Deliberately does not touch entity_resolver or
graph.py at all; resolving these references against real records is a
separate, later step. Requires a live GROQ_API_KEY and burns real quota
— run explicitly, not swept up in a full-suite pass.
"""
import pytest

from app.agents.request_understanding_agent import request_understanding_agent


@pytest.mark.asyncio
async def test_explicit_customer_reference():
    result = await request_understanding_agent("Check Delta Manufacturing.")

    assert len(result.references) >= 1
    ref = result.references[0]
    assert ref.entity_type == "customer"
    assert ref.identifier_type == "explicit_name"
    assert "Delta" in ref.identifier


@pytest.mark.asyncio
async def test_temporal_order_reference():
    result = await request_understanding_agent("Check the order we created last month.")

    assert len(result.references) >= 1
    ref = next((r for r in result.references if r.entity_type in ("sales_order", "order")), result.references[0])
    assert ref.identifier_type == "temporal"


@pytest.mark.asyncio
async def test_relative_order_reference():
    result = await request_understanding_agent("What's the status of their latest order?")

    assert len(result.references) >= 1
    ref = next((r for r in result.references if r.entity_type in ("sales_order", "order")), result.references[0])
    assert ref.identifier_type == "relative"


@pytest.mark.asyncio
async def test_nested_customer_and_order_reference():
    result = await request_understanding_agent(
        "The customer who bought 40 laptops last month wants replacements."
    )

    entity_types = {r.entity_type for r in result.references}
    # At minimum the customer reference must be caught — the exact
    # second entity_type label the model picks (order/return/delivery)
    # is judgment, not something to over-constrain in a first pass.
    assert "customer" in entity_types
    assert len(result.references) >= 1


@pytest.mark.asyncio
async def test_multiple_references_in_one_request():
    result = await request_understanding_agent("Check the latest order and invoice for Delta.")

    entity_types = {r.entity_type for r in result.references}
    assert len(result.references) >= 2
    assert "customer" in entity_types


@pytest.mark.asyncio
async def test_ambiguous_reference():
    result = await request_understanding_agent("Check that order.")

    assert len(result.references) >= 1
    assert result.references[0].identifier_type == "ambiguous"


@pytest.mark.asyncio
async def test_unsupported_request_with_a_reference():
    result = await request_understanding_agent("Arrange financing for that customer.")

    assert result.is_supported is False
