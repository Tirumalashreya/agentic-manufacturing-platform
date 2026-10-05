# app/routers/production.py
"""Closes the Order-to-Cash loop for produced (MTO/CTO/HYBRID) orders.

mes-integration notifies this endpoint once every ScheduledOperation on a
TS ProductionOrder is DONE — the first call into agent-orchestrator that
originates on the TS side rather than the other way around. Everything
this endpoint needs to actually bill (sales_order_id, customer, price,
quantity) was written onto the order's metadata at approval time by
_commit_production_plan (see app/graph.py) — without that write there is
nothing here to bill against, which is the deliberate, honest response
below rather than a guessed default.
"""
import asyncio

import httpx
from fastapi import APIRouter, HTTPException

from app.graph import _deliver_and_bill
from app.integrations import manufacturing_services as mfg
from app.tools.billing_tools import find_invoice_by_sales_order
from app.tools.delivery_tools import find_delivery_by_sales_order

router = APIRouter(prefix="/production-orders")


@router.post("/{ts_order_id}/complete")
async def complete_production_order(ts_order_id: str):
    order = await mfg.get_production_order(ts_order_id)
    metadata = order.get("metadata") or {}
    sales_order_id = metadata.get("salesOrderId")

    if not sales_order_id:
        # Real, expected case — not every ProductionOrder on the TS side
        # was created by this Production Planning Agent flow (e.g. demo/
        # seed orders, or ones created before this metadata write existed).
        # Nothing to bill, and that's not an error.
        return {"billed": False, "reason": "no sales_order_id on this production order's metadata"}

    quantity = metadata.get("quantity") or order.get("quantity")
    state = {
        "sales_order_id": sales_order_id,
        "customer_id": metadata.get("customerId"),
        "customer_name": metadata.get("customerName"),
        "product_id": metadata.get("productId"),
        "product_name": metadata.get("productName"),
        "price": metadata.get("price"),
        "quantity": quantity,
        "requested_deadline": None,
    }

    billing_update = await _deliver_and_bill(state, quantity)

    return {
        "billed": bool(billing_update["invoice_id"]),
        "sales_order_id": sales_order_id,
        "production_order_id": ts_order_id,
        "delivery_id": billing_update["delivery_id"],
        "delivery_status": billing_update["delivery_status"],
        "confirmed_delivery_date": billing_update["confirmed_delivery_date"],
        "invoice_id": billing_update["invoice_id"],
        "invoice_status": billing_update["invoice_status"],
        "invoice_amount": billing_update["invoice_amount"],
    }


# The Track Order panel's one real data source — Agent Console's approval
# screen used to be a dead end: it showed the plan at the moment you
# approved it and then never looked again, so anything that happened
# afterward (an operator starting/finishing real work on Execution, the
# order-to-cash loop firing on its own) was invisible unless you went and
# hunted for it on a different page. This is polled from the frontend
# every few seconds so that same screen stays honestly live instead of
# frozen — real status, real names, not a guess about what "should" have
# happened by now.
async def _build_tracking(order: dict, sales_order_id: str | None) -> dict:
    """Shared by the Track Order panel's own endpoint and the Sales
    Order detail page's Schedule tab (agreed with the user: reuse the
    Track Order panel's real data-fetching pattern rather than building
    a second version of it).

    Perf pass (agreed with the user, Phase 1 detail page was taking
    15-20s): routing and operators never depended on each other, and
    every scheduled operation's machine lookup was awaited one at a time
    even when several operations share the same machine. Same real
    calls, same real data, just not artificially serialized — real
    machine ids are deduped and fetched concurrently instead of once per
    operation."""
    routing, operators = await asyncio.gather(mfg.get_routing(order["productId"]), mfg.get_operators())

    operation_names: dict[str, str] = {}
    if routing:
        operation_names = {op["id"]: op["operation"] for op in routing["operations"]}
    operator_names = {o["id"]: o["name"] for o in operators}

    scheduled_ops = order.get("scheduledOperations", [])
    machine_ids = list({op["machineId"] for op in scheduled_ops if op.get("machineId")})
    machines = await asyncio.gather(*[mfg.get_machine(mid) for mid in machine_ids])
    machine_cache = {mid: machine["name"] for mid, machine in zip(machine_ids, machines)}

    operations = []
    for op in scheduled_ops:
        operations.append({
            "operation": operation_names.get(op.get("routingOperationId"), "?"),
            "machine": machine_cache.get(op.get("machineId")),
            "operator": operator_names.get(op.get("operatorId")),
            "status": op["status"],
            "scheduled_start": op.get("scheduledStart"),
            "scheduled_end": op.get("scheduledEnd"),
        })
    operations.sort(key=lambda o: o.get("scheduled_start") or "")

    delivery = find_delivery_by_sales_order(sales_order_id) if sales_order_id else None
    invoice = find_invoice_by_sales_order(sales_order_id) if sales_order_id else None

    return {
        "production_order_id": order["id"],
        "stage": order["status"],
        "operations": operations,
        "delivery": delivery,
        "invoice": invoice,
    }


@router.get("/{ts_order_id}/tracking")
async def production_order_tracking(ts_order_id: str, sales_order_id: str | None = None):
    # Real gap found live (agreed with the user): a production order that
    # genuinely no longer exists (e.g. after a demo-data reset, while a
    # browser tab still holds a stale reference to it) made
    # get_production_order's raise_for_status() throw an unhandled
    # httpx.HTTPStatusError, which FastAPI's default handler turned into
    # a 500 carrying the raw exception text — the Track Order panel then
    # showed that as a permanent, unrecoverable-looking error every poll,
    # forever, with no way to distinguish "genuinely gone" from "backend
    # hiccup." A real, clean 404 here is what actually lets the frontend
    # tell those apart and stop tracking something that's truly gone.
    try:
        order = await mfg.get_production_order(ts_order_id)
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 404:
            raise HTTPException(status_code=404, detail=f"No production order found with id {ts_order_id}")
        raise
    return await _build_tracking(order, sales_order_id)
