# app/tests/test_promise_capabilities.py
"""Phase 10 (Agentic Order Promise & Scenario Reasoning) — unit tests for
the bounded capability registry itself (app/capabilities/registry.py).

No real Groq/LLM calls anywhere in this file — the registry/dispatch
mechanics are pure Python plus mocked leaf functions, same convention
test_production_planning_agent.py already uses for mfg.* calls."""
import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from app.capabilities.registry import CAPABILITY_SPECS, dispatch, investigable_capabilities, register
from app.capabilities.schemas import CapabilityCall, CapabilityResult, CapabilitySpec


def test_every_registered_read_capability_wraps_a_real_pre_existing_function():
    # Confirms graph.py's import-time registration actually ran (importing
    # app.graph triggers app.capabilities' own __init__, which registers
    # the 5 leaf-function capabilities, plus graph.py registers
    # simulate_schedule itself) — a missing registration here would mean
    # the capability silently doesn't exist for the reasoning loop at all.
    import app.graph  # noqa: F401 — import side effect is what's under test

    expected = {
        "inspect_customer", "inspect_inventory", "inspect_production_requirements",
        "assess_capacity", "inspect_affected_orders", "simulate_schedule",
        # Phase 13
        "simulate_reschedule",
    }
    assert expected.issubset(CAPABILITY_SPECS.keys())


@pytest.mark.asyncio
async def test_simulate_reschedule_capability_requires_real_identity():
    import app.graph  # noqa: F401

    result = await dispatch(CapabilityCall(capability="simulate_reschedule", arguments={"plant_id": "plant-1"}, reason="test"))
    assert result.success is False
    assert "production_order_id" in result.errors["reason"]


@pytest.mark.asyncio
async def test_simulate_reschedule_capability_wraps_the_real_what_if_call():
    import app.graph  # noqa: F401

    with patch("app.capabilities.manufacturing_capabilities.mfg.simulate_reschedule", AsyncMock(return_value={"simulatedOperations": []})):
        result = await dispatch(CapabilityCall(capability="simulate_reschedule", arguments={"plant_id": "plant-1", "production_order_id": "po-1"}, reason="test"))
    assert result.success is True
    assert result.authoritative_source == "scheduling-service:what-if"


def test_consequential_capabilities_are_never_investigable():
    import app.graph  # noqa: F401

    investigable_names = {spec.name for spec in investigable_capabilities()}
    assert "execute_approved_plan" not in investigable_names
    assert "request_human_approval" not in investigable_names
    for spec in investigable_capabilities():
        assert spec.phase == "investigate"
        assert spec.consequential is False


@pytest.mark.asyncio
async def test_unknown_capability_is_rejected_not_guessed_at():
    result = await dispatch(CapabilityCall(capability="delete_everything", arguments={}, reason="test"))
    assert result.success is False
    assert "Unknown capability" in result.errors["reason"]


@pytest.mark.asyncio
async def test_consequential_capability_cannot_be_dispatched_even_if_named_directly():
    # Belt-and-suspenders boundary (brief §14): even a caller that somehow
    # got a consequential capability's exact name can never have it
    # actually run through this path.
    register(
        CapabilitySpec(
            name="_test_consequential", description="test", read_write="none",
            authoritative_source="none", timeout_seconds=1.0, phase="consequential", consequential=True,
        ),
        AsyncMock(side_effect=AssertionError("must never be called — dispatch should block before reaching this")),
    )
    result = await dispatch(CapabilityCall(capability="_test_consequential", arguments={}, reason="test"))
    assert result.success is False
    assert "consequential" in result.errors["reason"]


@pytest.mark.asyncio
async def test_capability_timeout_is_handled_not_raised():
    async def _slow(_args: dict) -> CapabilityResult:
        await asyncio.sleep(0.5)
        return CapabilityResult(capability="_test_slow", success=True, authoritative_source="none")

    register(
        CapabilitySpec(
            name="_test_slow", description="test", read_write="read",
            authoritative_source="none", timeout_seconds=0.05, phase="investigate",
        ),
        _slow,
    )
    result = await dispatch(CapabilityCall(capability="_test_slow", arguments={}, reason="test"))
    assert result.success is False
    assert "Timed out" in result.errors["reason"]


@pytest.mark.asyncio
async def test_capability_implementation_exception_is_caught_not_raised():
    async def _boom(_args: dict) -> CapabilityResult:
        raise RuntimeError("downstream service exploded")

    register(
        CapabilitySpec(
            name="_test_boom", description="test", read_write="read",
            authoritative_source="none", timeout_seconds=5.0, phase="investigate",
        ),
        _boom,
    )
    result = await dispatch(CapabilityCall(capability="_test_boom", arguments={}, reason="test"))
    assert result.success is False
    assert "downstream service exploded" in result.errors["reason"]


@pytest.mark.asyncio
async def test_inspect_customer_returns_typed_result_from_the_real_function():
    import app.graph  # noqa: F401

    with patch("app.capabilities.manufacturing_capabilities.get_customer", return_value={
        "customer_id": "C001", "customer_name": "Acme Corp", "active": True, "credit_limit": 100000.0,
    }):
        result = await dispatch(CapabilityCall(capability="inspect_customer", arguments={"customer_name": "Acme Corp"}, reason="test"))
    assert result.success is True
    assert result.authoritative_source == "mock-erp:Customer Master"
    assert result.data["customer_id"] == "C001"
    assert result.data["credit_limit"] == 100000.0


@pytest.mark.asyncio
async def test_inspect_customer_reports_not_found_honestly():
    import app.graph  # noqa: F401

    with patch("app.capabilities.manufacturing_capabilities.get_customer", return_value=None):
        result = await dispatch(CapabilityCall(capability="inspect_customer", arguments={"customer_name": "Nobody"}, reason="test"))
    assert result.success is False
    assert "No customer found" in result.errors["reason"]


@pytest.mark.asyncio
async def test_inspect_inventory_sums_real_stock_rows():
    import app.graph  # noqa: F401

    with patch("app.capabilities.manufacturing_capabilities.erp.get_stock", return_value=[
        {"plant_id": "PL1", "stock_qty": 120}, {"plant_id": "PL2", "stock_qty": 80},
    ]):
        result = await dispatch(CapabilityCall(capability="inspect_inventory", arguments={"product_id": "P001"}, reason="test"))
    assert result.success is True
    assert result.data["stock_total"] == 200


@pytest.mark.asyncio
async def test_inspect_affected_orders_requires_a_real_production_order_id():
    import app.graph  # noqa: F401

    result = await dispatch(CapabilityCall(capability="inspect_affected_orders", arguments={"plant_id": "PL1"}, reason="test"))
    assert result.success is False
    assert "production_order_id is required" in result.errors["reason"]
