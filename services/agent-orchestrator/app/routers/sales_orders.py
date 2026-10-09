# app/routers/sales_orders.py
"""Phase 1 of the Ledger order-detail workspace (agreed with the user):
one real, read-only assembly of everything currently known about a
Sales Order — its own record, its linked production order if one
exists, real materials/routing, the real schedule, and real capacity
status. No committing actions live here; Phase 1 is deliberately
read-only. No mock data — anything not currently derivable from real
systems is reported as missing (via `missing`), never fabricated.
"""
import asyncio

from fastapi import APIRouter, Depends, HTTPException

from app.graph import MANUFACTURING_PLANT_ID
from app.integrations import manufacturing_services as mfg
from app.integrations import order_domain
from app.routers.production import _build_tracking
from app.security import require_role
from app.tools.billing_tools import find_invoice_by_sales_order
from app.tools.delivery_tools import find_delivery_by_sales_order
from app.tools.sales_tools import find_sales_order

router = APIRouter(prefix="/sales-orders")


# Phase 14 (Promise Risk & Decision Inbox) — declared before the
# `/{sales_order_id}/...` routes below (static-before-dynamic; FastAPI
# would not actually collide here since none of those are a bare single
# segment, but this keeps the ordering unambiguous). Pure passthrough to
# order-service's real aggregation + deterministic classification
# endpoint (order_domain.get_promise_inbox) — no reasoning, no LLM, and
# this is the Ledger app's only ingress into agent-orchestrator, so this
# is the one new seam the frontend's existing /api/orchestrator proxy
# needs to reach it.
@router.get("/promises")
async def promise_inbox(
    limit: int | None = None,
    offset: int | None = None,
    search: str | None = None,
    riskStatus: str | None = None,
    pendingApprovalOnly: bool | None = None,
):
    return await order_domain.get_promise_inbox(
        limit=limit,
        offset=offset,
        search=search,
        risk_status=riskStatus,
        pending_approval_only=pendingApprovalOnly,
    )


async def _build_production_plan(production_order: dict) -> dict:
    """Live materials/routing snapshot — deliberately a fresh read, not
    the frozen verdict from the original planning run (that verdict was
    only ever shown transiently on the approval screen and isn't stored
    indexed by sales_order_id anywhere; see the sibling PR gap noted in
    `missing` below). Real current inventory against the real BOM is
    honest, current information — just not a replay of the original
    AI-rendered explanation.

    Perf pass (agreed with the user): BOM and routing never depended on
    each other, and each component's inventory check was awaited one at
    a time. Same real calls, same real numbers, just not serialized."""
    manufacturing_product_id = production_order["productId"]
    quantity = production_order["quantity"]
    bom, routing = await asyncio.gather(mfg.get_bom(manufacturing_product_id), mfg.get_routing(manufacturing_product_id))

    async def _material(line: dict) -> dict:
        inventory_rows = await mfg.get_inventory(line["componentId"])
        available = sum(row["qtyUnrestricted"] for row in inventory_rows)
        required = line["quantityPer"] * quantity
        return {
            "component_id": line["componentId"],
            "component_name": line["component"]["family"],
            "required": required,
            "available": available,
            "shortage": max(required - available, 0),
        }

    materials = list(await asyncio.gather(*[_material(line) for line in bom["lines"]])) if bom else []

    routing_operations = []
    if routing:
        for op in routing["operations"]:
            routing_operations.append({
                "operation_id": op["id"],
                "operation": op["operation"],
                "op_number": op["opNumber"],
                "work_center_code": op["workCenter"]["code"],
            })

    has_shortage = any(m["shortage"] > 0 for m in materials)
    if not bom and not routing:
        # Phase 2 (agreed with the user): renamed from "UNPLANNABLE" to
        # match graph.py's Cause 1 — a real config gap (no BOM/routing at
        # all), not a scheduling-capacity question. This endpoint never
        # calls the scheduler at all (a live materials-only snapshot, see
        # this function's own docstring), so it has no way to distinguish
        # a genuine capacity wait from anything else — WAITING_FOR_PRODUCTION_SLOT/
        # PLANNER_REVIEW simply aren't computable here and aren't returned.
        verdict = "PLANNING_CONFIGURATION_ISSUE"
    elif has_shortage:
        verdict = "MATERIAL_SHORTAGE"
    else:
        verdict = "PASS"

    return {
        "quantity": quantity,
        "materials": materials,
        "routing_operations": routing_operations,
        "verdict": verdict,
        "verdict_basis": "current live material availability — not a replay of the original at-approval verdict",
    }


async def _fetch_capacity(plant_id: str) -> tuple[dict | None, str | None]:
    """Isolated exactly like the original try/except was — a down APS
    Platform/scheduling-service shouldn't fail the rest of the page, and
    now that this runs inside an asyncio.gather alongside two other real
    calls, an uncaught exception here would fail those too."""
    try:
        return await mfg.get_capacity_status(plant_id), None
    except Exception:
        return None, "Capacity/workload status unavailable — APS Platform or scheduling-service may be down."


@router.get("/{sales_order_id}/fulfillment")
async def sales_order_fulfillment(sales_order_id: str):
    """Order-to-production Phase 1: the real, persisted OrderLine/
    FulfillmentPlan/FulfillmentLine record for this order, if the
    dual-write succeeded when it was approved. Additive — nothing existing
    calls this yet. `available: false` (not a 404) for any order that
    predates Phase 1 or whose dual-write failed — an honest, reportable
    state, not an error."""
    if find_sales_order(sales_order_id) is None:
        raise HTTPException(status_code=404, detail=f"No sales order found with id {sales_order_id}")

    order = await order_domain.get_fulfillment_by_external_order_id(sales_order_id)
    if order is None:
        return {"available": False}

    lines = order.get("orderLines") or []
    line = lines[0] if lines else None
    plan = (line or {}).get("fulfillmentPlan")
    return {
        "available": True,
        "sales_order_id": order["id"],
        "status": order["status"],
        "order_line": None if line is None else {
            "id": line["id"],
            "product_name": line["productName"],
            "quantity": line["quantity"],
            "unit_price": line["unitPrice"],
        },
        "fulfillment_plan": None if plan is None else {
            "strategy": plan["strategy"],
            "reasoning": plan.get("reasoning"),
            "lines": [
                {
                    "source_type": l["sourceType"],
                    "quantity": l["quantity"],
                    "status": l["status"],
                    "production_order_id": l.get("productionOrderId"),
                    "vendor_id": l.get("vendorId"),
                    "vendor_name": l.get("vendorName"),
                    # Order Orchestration (Phase 2): real promised date and
                    # execution reference, once the execution-lifecycle
                    # patch has run — both stay null until then.
                    "promised_date": l.get("promisedDate"),
                    "execution_reference": l.get("executionReference"),
                    # Exceptions/Holds: why this line is FAILED/ON_HOLD/
                    # CANCELLED — null for every other status.
                    "reason": l.get("reason"),
                }
                for l in plan.get("lines", [])
            ],
        },
    }


@router.get("/{sales_order_id}/detail")
async def sales_order_detail(sales_order_id: str):
    sales_order = find_sales_order(sales_order_id)
    if sales_order is None:
        raise HTTPException(status_code=404, detail=f"No sales order found with id {sales_order_id}")

    missing: list[str] = []

    production_order_summary = await mfg.find_production_order_by_sales_order(sales_order_id)
    production_plan = None
    schedule = None
    capacity = None
    production_order = None
    work_centers: list[dict] = []

    if production_order_summary is None:
        missing.append(
            "No linked production order — either this order was fulfilled from stock (MTS), "
            "sourced from a vendor (Trading/Third-Party), or hasn't been approved yet."
        )
    else:
        # The list endpoint used to find this order by its metadata
        # doesn't include scheduledOperations (real bug found live while
        # verifying Phase 1: schedule.operations came back empty) — the
        # single-order read does, so re-fetch by id before building
        # anything that needs the real operations.
        production_order = await mfg.get_production_order(production_order_summary["id"])

        # Perf pass (agreed with the user, was taking 15-20s): the plan,
        # the schedule, the capacity status, and the real work center
        # list (Phase 2's What-if form options) never depended on one
        # another — each only needs production_order/sales_order_id,
        # already in hand. Run concurrently instead of one after another.
        # Capacity keeps its own isolated error handling (a down APS
        # Platform shouldn't fail the whole page) via _fetch_capacity.
        plant_id = production_order.get("plantId") or MANUFACTURING_PLANT_ID
        production_plan, schedule, (capacity, capacity_error), work_centers = await asyncio.gather(
            _build_production_plan(production_order),
            _build_tracking(production_order, sales_order_id),
            _fetch_capacity(plant_id),
            mfg.list_work_centers(plant_id),
        )
        if capacity_error:
            missing.append(capacity_error)

    missing.append(
        "Original AI planning verdict/explanation is not retrievable per sales order — it was only ever "
        "shown transiently on the approval screen at planning time, not persisted indexed by sales_order_id."
    )

    # Order Control Center (Phase 3, agreed with the user): real delivery/
    # invoice records, looked up independently of whether a production
    # order exists. _build_tracking above already does this same lookup,
    # but only ever runs when a production order is linked — leaving the
    # most common case (a pure-stock MTS order, which still gets a real
    # delivery+invoice via _deliver_and_bill) with none here at all. This
    # is the one, always-attempted, real source for both.
    delivery = find_delivery_by_sales_order(sales_order_id)
    invoice = find_invoice_by_sales_order(sales_order_id)
    if not delivery and not invoice:
        missing.append("No delivery or invoice recorded yet for this order.")

    return {
        "sales_order": sales_order,
        "production_order_id": production_order["id"] if production_order else None,
        "production_plan": production_plan,
        "schedule": schedule,
        "capacity": capacity,
        "delivery": delivery,
        "invoice": invoice,
        "work_centers": [{"id": wc["id"], "code": wc["code"]} for wc in work_centers],
        "missing": missing,
    }


# Phase 2 (agreed with the user): a real, non-committing what-if against
# a real capacity hypothetical — "what if WC-ASSY had one more machine?"
# Nothing is written; the same real engine used for pre-approval planning
# previews runs in a scratch namespace and reports whether THIS order's
# own schedule would change. No LLM involved — a real number in, a real
# number out, same principle as every deterministic calculation in this
# codebase.
@router.post("/{sales_order_id}/simulate")
async def simulate_sales_order_schedule(sales_order_id: str, body: dict):
    sales_order = find_sales_order(sales_order_id)
    if sales_order is None:
        raise HTTPException(status_code=404, detail=f"No sales order found with id {sales_order_id}")

    production_order_summary = await mfg.find_production_order_by_sales_order(sales_order_id)
    if production_order_summary is None:
        raise HTTPException(status_code=400, detail="No linked production order — nothing to simulate against.")

    work_center_id = body.get("work_center_id")
    additional_machine_count = body.get("additional_machine_count")
    if not work_center_id or additional_machine_count is None:
        raise HTTPException(status_code=422, detail="work_center_id and additional_machine_count are required.")

    plant_id = production_order_summary.get("plantId") or MANUFACTURING_PLANT_ID
    result = await mfg.simulate_schedule(
        plant_id,
        production_order_summary["id"],
        [{"workCenterId": work_center_id, "additionalMachineCount": additional_machine_count}],
    )
    return result


# Real, committing — buildable now that scheduling-service's SINGLE/
# AFFECTED scope genuinely narrows to real orders (see pipeline.ts's
# resolveScopedOrderIds), not the whole plant. Two named actions, not a
# raw scope/mode passthrough — this is what keeps the UI/chat semantics
# honest about blast radius (agreed with the user):
#   "reschedule" -> scope SINGLE, mode FORWARD — touches only this order.
#   "optimize"   -> scope AFFECTED, mode BOTTLENECK — touches this order
#                    plus any other real order sharing its work centers;
#                    labeled as such everywhere this result is shown.
# Never defaults to ALL, never lets a caller pass an arbitrary scope.
_RESCHEDULE_KINDS = {
    "reschedule": {"scope": "SINGLE", "mode": "FORWARD"},
    "optimize": {"scope": "AFFECTED", "mode": "BOTTLENECK"},
}


async def _resolve_reschedule_target(sales_order_id: str) -> tuple[dict, dict]:
    sales_order = find_sales_order(sales_order_id)
    if sales_order is None:
        raise HTTPException(status_code=404, detail=f"No sales order found with id {sales_order_id}")
    production_order_summary = await mfg.find_production_order_by_sales_order(sales_order_id)
    if production_order_summary is None:
        raise HTTPException(status_code=400, detail="No linked production order — nothing to reschedule.")
    return sales_order, production_order_summary


# Real, read-only preview — never commits. Lets Ledger's Actions panel (or
# the Agent Console's conversational approval card, via the same
# mfg.get_affected_orders_preview call) show the real target + real
# affected order ids before a reschedule/optimize is ever approved.
@router.get("/{sales_order_id}/reschedule-preview")
async def preview_sales_order_reschedule(sales_order_id: str, kind: str):
    if kind not in _RESCHEDULE_KINDS:
        raise HTTPException(status_code=422, detail=f"kind must be one of {sorted(_RESCHEDULE_KINDS)}.")
    _, production_order_summary = await _resolve_reschedule_target(sales_order_id)
    plant_id = production_order_summary.get("plantId") or MANUFACTURING_PLANT_ID
    scope = _RESCHEDULE_KINDS[kind]["scope"]
    result = await mfg.get_affected_orders_preview(plant_id, production_order_summary["id"], scope)
    return result


@router.post("/{sales_order_id}/reschedule", dependencies=[Depends(require_role("PLANNER"))])
async def reschedule_sales_order(sales_order_id: str, body: dict):
    kind = body.get("kind", "reschedule")
    if kind not in _RESCHEDULE_KINDS:
        raise HTTPException(status_code=422, detail=f"kind must be one of {sorted(_RESCHEDULE_KINDS)}.")
    _, production_order_summary = await _resolve_reschedule_target(sales_order_id)
    plant_id = production_order_summary.get("plantId") or MANUFACTURING_PLANT_ID
    action = _RESCHEDULE_KINDS[kind]
    result = await mfg.reschedule_production_order(plant_id, production_order_summary["id"], action["scope"], action["mode"])
    return result
