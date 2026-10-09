# app/capabilities/manufacturing_capabilities.py
"""Phase 10 — registers the real read capabilities. Every implementation
below is a thin wrapper around a function that already existed before
this phase (see PHASE_10_TRACE in the PR description / session report for
the exact mapping) — no new deterministic business logic is introduced
here, only typed normalization into CapabilityResult.

Deliberately does NOT register `simulate_schedule` — its real
implementation (graph.py::_plan_production_via_manufacturing_services)
depends on graph-local helpers (production_planning_agent, configuration
handling, MANUFACTURING_PRODUCT_IDS) and registering it from graph.py
itself avoids a circular import, at the cost of that one registration
call living in a different file than the rest. Importing this module (see
graph.py's own import) is what makes the registrations below take effect.
"""
from app.capabilities.registry import register
from app.capabilities.schemas import CapabilityResult, CapabilitySpec
from app.erp.factory import default_erp_adapter as erp
from app.integrations import manufacturing_services as mfg
from app.tools.customer_tools import get_customer


async def _inspect_customer(args: dict) -> CapabilityResult:
    customer_name = args.get("customer_name")
    customer = get_customer(customer_name)
    if customer is None:
        return CapabilityResult(
            capability="inspect_customer",
            success=False,
            authoritative_source="mock-erp:Customer Master",
            errors={"reason": f"No customer found matching {customer_name!r}."},
        )
    return CapabilityResult(
        capability="inspect_customer",
        success=True,
        authoritative_source="mock-erp:Customer Master",
        data={
            "customer_id": customer["customer_id"],
            "customer_name": customer["customer_name"],
            "active": customer["active"],
            "credit_limit": customer["credit_limit"],
        },
    )


register(
    CapabilitySpec(
        name="inspect_customer",
        description="Look up a customer's real active status and credit limit.",
        read_write="read",
        authoritative_source="mock-erp:Customer Master",
        timeout_seconds=5.0,
        phase="investigate",
    ),
    _inspect_customer,
)


async def _inspect_inventory(args: dict) -> CapabilityResult:
    product_id = args.get("product_id")
    if not product_id:
        return CapabilityResult(
            capability="inspect_inventory", success=False, authoritative_source="mock-erp:Stock",
            errors={"reason": "product_id is required."},
        )
    rows = erp.get_stock(product_id)
    total = sum(row["stock_qty"] for row in rows)
    return CapabilityResult(
        capability="inspect_inventory",
        success=True,
        authoritative_source="mock-erp:Stock",
        data={"product_id": product_id, "stock_total": total, "by_location": rows},
    )


register(
    CapabilitySpec(
        name="inspect_inventory",
        description="Check real on-hand stock for a finished-good product.",
        read_write="read",
        authoritative_source="mock-erp:Stock",
        timeout_seconds=5.0,
        phase="investigate",
    ),
    _inspect_inventory,
)


async def _inspect_production_requirements(args: dict) -> CapabilityResult:
    manufacturing_product_id = args.get("manufacturing_product_id")
    if not manufacturing_product_id:
        return CapabilityResult(
            capability="inspect_production_requirements", success=False, authoritative_source="aps-platform:BOM/Routing",
            errors={"reason": "No manufacturing master data is mapped for this product."},
        )
    bom = await mfg.get_bom(manufacturing_product_id)
    routing = await mfg.get_routing(manufacturing_product_id)
    if not bom and not routing:
        return CapabilityResult(
            capability="inspect_production_requirements", success=False, authoritative_source="aps-platform:BOM/Routing",
            errors={"reason": "No BOM or routing master data exists for this product."},
        )
    return CapabilityResult(
        capability="inspect_production_requirements",
        success=True,
        authoritative_source="aps-platform:BOM/Routing",
        data={
            "has_bom": bom is not None,
            "has_routing": routing is not None,
            "bom_line_count": len(bom["lines"]) if bom else 0,
            "routing_operation_count": len(routing["operations"]) if routing else 0,
        },
    )


register(
    CapabilitySpec(
        name="inspect_production_requirements",
        description="Check whether real Bill-of-Materials and routing master data exist for the manufacturing product.",
        read_write="read",
        authoritative_source="aps-platform:BOM/Routing",
        timeout_seconds=15.0,
        phase="investigate",
    ),
    _inspect_production_requirements,
)


async def _assess_capacity(args: dict) -> CapabilityResult:
    plant_id = args.get("plant_id")
    status = await mfg.get_capacity_status(plant_id)
    return CapabilityResult(
        capability="assess_capacity",
        success=True,
        authoritative_source="scheduling-service:capacity",
        data=status,
    )


register(
    CapabilitySpec(
        name="assess_capacity",
        description="Read current real workload/capacity status for the manufacturing plant.",
        read_write="read",
        authoritative_source="scheduling-service:capacity",
        timeout_seconds=15.0,
        phase="investigate",
    ),
    _assess_capacity,
)


async def _inspect_affected_orders(args: dict) -> CapabilityResult:
    plant_id = args.get("plant_id")
    production_order_id = args.get("production_order_id")
    scope = args.get("scope", "AFFECTED")
    if not production_order_id:
        return CapabilityResult(
            capability="inspect_affected_orders", success=False, authoritative_source="aps-platform:affected-orders",
            errors={"reason": "production_order_id is required — only meaningful once a draft production plan exists."},
        )
    preview = await mfg.get_affected_orders_preview(plant_id, production_order_id, scope)
    return CapabilityResult(
        capability="inspect_affected_orders",
        success=True,
        authoritative_source="aps-platform:affected-orders",
        data=preview,
    )


register(
    CapabilitySpec(
        name="inspect_affected_orders",
        description="Check which other orders share capacity with a draft production plan — only usable once one exists.",
        read_write="read",
        authoritative_source="aps-platform:affected-orders",
        timeout_seconds=15.0,
        phase="investigate",
    ),
    _inspect_affected_orders,
)


# Phase 13 — reserved the same way simulate_schedule already is (see
# graph.py's own exclusion list in promise_reasoning_node): it has a
# real network cost and is only ever useful once a specific recovery
# alternative (RESCHEDULE_BOTTLENECK) has already been chosen to
# investigate, never as a free-form "go check something" pick. Registered
# here (not graph.py) because, unlike simulate_schedule, its real
# implementation (mfg.simulate_reschedule) needs no graph-local helper —
# a plain HTTP call to scheduling-service's own already-existing
# POST /scheduling/what-if, nothing persisted.
async def _simulate_reschedule_capability(args: dict) -> CapabilityResult:
    plant_id = args.get("plant_id")
    production_order_id = args.get("production_order_id")
    if not plant_id or not production_order_id:
        return CapabilityResult(
            capability="simulate_reschedule", success=False, authoritative_source="scheduling-service:what-if",
            errors={"reason": "plant_id and production_order_id are required."},
        )
    result = await mfg.simulate_reschedule(plant_id, production_order_id, scope="AFFECTED", mode="BOTTLENECK")
    return CapabilityResult(
        capability="simulate_reschedule",
        success=True,
        authoritative_source="scheduling-service:what-if",
        data=result,
    )


register(
    CapabilitySpec(
        name="simulate_reschedule",
        description=(
            "Run a real what-if bottleneck-mode reschedule simulation for an existing (e.g. disrupted) production "
            "order — non-committing, no ScheduleRun/ScheduledOperation/ResourceReservation is ever persisted."
        ),
        read_write="read",
        authoritative_source="scheduling-service:what-if",
        timeout_seconds=30.0,
        phase="investigate",
    ),
    _simulate_reschedule_capability,
)


# Consequential capabilities (brief §2/§14) — registered here for a
# complete, self-documenting registry, but deliberately given no reachable
# implementation: registry.dispatch() already refuses any phase=="consequential"
# capability before ever calling its implementation, so these stubs exist
# only as a canary (if that guard is ever weakened, these raise loudly
# instead of silently doing something real). The actual approval/execution
# work is NOT reimplemented here — it's the existing Stage 04 machinery
# (app/approval_proposal.py, app/db.py, plan_executor.execute_gated_action),
# called directly by graph.py's promise_reasoning_node and
# approvals.py's resolve_sales_order_approval, never through this registry.
async def _not_directly_callable(args: dict) -> CapabilityResult:
    raise AssertionError("consequential capabilities must never be dispatched directly — registry.dispatch() should have refused this already.")


register(
    CapabilitySpec(
        name="request_human_approval",
        description="Raise the existing Stage 04 approval gate for a recommended plan — reuses save_pending_approval/compute_proposal_hash verbatim.",
        read_write="none",
        authoritative_source="agent-orchestrator:approval-state",
        timeout_seconds=1.0,
        phase="consequential",
        consequential=True,
    ),
    _not_directly_callable,
)

register(
    CapabilitySpec(
        name="execute_approved_plan",
        description="Execute an approved plan via execute_gated_action + run_post_approval_fulfillment — reuses the existing create_order execution path verbatim.",
        read_write="read_with_side_effect",
        authoritative_source="order-service / aps-platform",
        timeout_seconds=1.0,
        phase="consequential",
        consequential=True,
    ),
    _not_directly_callable,
)
