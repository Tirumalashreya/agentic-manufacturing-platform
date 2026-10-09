# app/capabilities/registry.py
"""Phase 10 — the bounded capability registry.

Deliberately NOT "the LLM can call any function in the repository." Every
entry here is a direct, typed wrapper around an already-existing,
already-tested deterministic function (manufacturing_services.py,
customer_tools.py, the mock-ERP adapter) — same philosophy as
plan_executor.py's explicit allow-list, applied to information-gathering
instead of order mutation. Adding a new capability means adding a new
registration call here, a deliberate, reviewable change — never something
a model can expand at runtime.
"""
import asyncio
import logging
from typing import Awaitable, Callable

from app.capabilities.schemas import CapabilityCall, CapabilityResult, CapabilitySpec

logger = logging.getLogger(__name__)

CAPABILITY_SPECS: dict[str, CapabilitySpec] = {}
_IMPLEMENTATIONS: dict[str, Callable[[dict], Awaitable[CapabilityResult]]] = {}


def register(spec: CapabilitySpec, implementation: Callable[[dict], Awaitable[CapabilityResult]]) -> None:
    CAPABILITY_SPECS[spec.name] = spec
    _IMPLEMENTATIONS[spec.name] = implementation


def investigable_capabilities() -> list[CapabilitySpec]:
    """What the capability-selector reasoning loop is allowed to see and
    choose from — excludes "compose" (fixed orchestration steps) and
    "consequential" (real mutations) phases entirely. This is the one
    function that decides what the model can even be offered; it is not
    merely a UI filter."""
    return [spec for spec in CAPABILITY_SPECS.values() if spec.phase == "investigate" and not spec.consequential]


async def dispatch(call: CapabilityCall) -> CapabilityResult:
    """The only way any capability actually runs. Unknown capability names
    and consequential capabilities are rejected here, not upstream —
    so even a bug in a caller that forgot to filter can never result in an
    unauthorized or mutating call actually executing."""
    spec = CAPABILITY_SPECS.get(call.capability)
    if spec is None:
        return CapabilityResult(
            capability=call.capability,
            success=False,
            authoritative_source="none",
            errors={"reason": f"Unknown capability '{call.capability}' — not in the registry."},
        )
    if spec.consequential or spec.phase == "consequential":
        return CapabilityResult(
            capability=call.capability,
            success=False,
            authoritative_source=spec.authoritative_source,
            errors={"reason": f"'{call.capability}' is consequential and cannot be invoked from the reasoning loop."},
        )

    impl = _IMPLEMENTATIONS[call.capability]
    try:
        return await asyncio.wait_for(impl(call.arguments), timeout=spec.timeout_seconds)
    except asyncio.TimeoutError:
        return CapabilityResult(
            capability=call.capability,
            success=False,
            authoritative_source=spec.authoritative_source,
            errors={"reason": f"Timed out after {spec.timeout_seconds}s."},
        )
    except Exception as exc:  # noqa: BLE001 — a capability failure must never crash the reasoning loop
        logger.warning("Capability %s failed: %s", call.capability, exc)
        return CapabilityResult(
            capability=call.capability,
            success=False,
            authoritative_source=spec.authoritative_source,
            errors={"reason": str(exc)},
        )
