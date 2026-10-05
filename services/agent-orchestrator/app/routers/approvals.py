# app/routers/approvals.py
from fastapi import APIRouter, Depends, HTTPException

from app import db
from app.graph import run_post_approval_fulfillment
from app.integrations import manufacturing_services as mfg
from app.security import ForwardedUser, require_role
from app.tools.financial_tools import (
    list_actionable_financial_adjustments,
    post_financial_adjustment,
    resolve_financial_approval,
)
from app.tools.plan_executor import execute_gated_action
from pydantic import BaseModel

router = APIRouter(prefix="/approvals")

# Auth/Authz hardening, Phase 1 (Finding 2 precursor — the approval-state
# gap itself is a separate, later phase; this only establishes WHO may
# approve). Every endpoint below commits a real business record (a Sales
# Order, a reschedule, a financial posting) — PLANNER is the lowest real
# role with operational-commit authority per UserRole's own ordering
# (VIEWER < PLANNER < ADMIN < OWNER); VIEWER stays read-only everywhere.
_require_planner = Depends(require_role("PLANNER"))


class ResolveRequest(BaseModel):
    decision: str
    resolved_by: str = "SYSTEM"


# Approval State hardening (agreed with the user) — Finding 2.1/2.2's real
# fix. These two request bodies used to carry the entire proposal
# `context` back from the client, trusted verbatim ("the frontend echoes
# it back verbatim, nothing is re-derived server-side" — the exact gap the
# original audit found: replayable, tamperable, no durable record at all).
# Both now carry only `run_id` — the server looks up its OWN stored
# payload (see db.save_pending_approval, written the moment the gate was
# first reached) and executes against THAT, never anything the client
# resends. quantity_override is the one real, pre-existing exception:
# Agent Console's approval card already lets a human edit the proposed
# quantity before approving (see agent-console/page.tsx's editedQuantity)
# — a legitimate part of what's being approved, not a bypass of it, so it
# stays as an explicit, narrow, single-field override rather than
# reopening the whole payload to client control.
class RescheduleApprovalRequest(BaseModel):
    run_id: str
    decision: str


class SalesOrderApprovalRequest(BaseModel):
    run_id: str
    decision: str
    quantity_override: int | None = None
    # Human fulfillment override (agreed with the user): only meaningful
    # when the approval preview said vendor_available — see
    # run_post_approval_fulfillment's own guard for why this is ignored
    # otherwise rather than erroring. A real-time decision-time choice,
    # not a proposal-time fact, so it's supplied fresh here same as before.
    prefer_vendor: bool = False


def _approval_error(run_id: str, approval: dict | None, expected_action: str) -> HTTPException:
    """Builds an honest, specific error for a failed claim — the caller
    already knows the atomic UPDATE matched zero rows; this figures out
    why, by re-reading the row, so 'already resolved' and 'expired' and
    'never existed' are never collapsed into the same generic failure."""
    if approval is None:
        return HTTPException(status_code=404, detail=f"No approval found for run {run_id}")
    if approval["approvalAction"] != expected_action:
        return HTTPException(
            status_code=400,
            detail=f"Run {run_id} is not awaiting a {expected_action} approval (found {approval['approvalAction']!r})",
        )
    status = approval["approvalStatus"]
    if status == "EXPIRED":
        return HTTPException(status_code=410, detail=f"Approval for run {run_id} has expired — request a new one.")
    if status in ("APPROVED", "REJECTED", "CONSUMED"):
        return HTTPException(
            status_code=409,
            detail=f"Approval for run {run_id} was already resolved (status: {status}) — it cannot be actioned again.",
        )
    return HTTPException(status_code=409, detail=f"Approval for run {run_id} is not awaiting a decision (status: {status}).")


# Two human-in-the-loop gates are wired into the live graph today:
# financial_node's PENDING_APPROVAL branch, and composed_execution_node's
# create_order gate (see plan_executor.py). Other domains' operational
# actions (milestone sign-off, shipment, sale reporting, ...) aren't
# approval gates and don't belong here.
@router.get("/financial")
async def list_financial_approvals():
    return {"items": list_actionable_financial_adjustments()}


@router.post("/financial/{financial_adjustment_id}/resolve", dependencies=[_require_planner])
async def resolve_financial(financial_adjustment_id: str, body: ResolveRequest):
    result = resolve_financial_approval(financial_adjustment_id, body.decision, approved_by=body.resolved_by)
    if not result["resolved"]:
        raise HTTPException(status_code=400, detail=result["reason"])
    return result


@router.post("/financial/{financial_adjustment_id}/post", dependencies=[_require_planner])
async def post_financial(financial_adjustment_id: str):
    result = post_financial_adjustment(financial_adjustment_id)
    if not result["posted"]:
        raise HTTPException(status_code=400, detail=result["reason"])
    return result


# The other half of the composed-execution approval gate — the only
# place a gated action (currently just create_order) actually runs. A
# REJECTED decision touches nothing; nothing is written to the ERP until
# a human explicitly approves here. Approval State hardening: the claim
# (PENDING -> APPROVED/REJECTED, atomically, single-winner) happens
# BEFORE any real mutation is even attempted — a losing concurrent/replayed
# request never reaches execute_gated_action at all, so there's no window
# in which two callers can both create a real Sales Order from one
# approval.
@router.post("/sales-order/resolve")
async def resolve_sales_order_approval(
    body: SalesOrderApprovalRequest, user: ForwardedUser = Depends(require_role("PLANNER"))
):
    if body.decision not in ("APPROVED", "REJECTED"):
        raise HTTPException(status_code=400, detail=f"Invalid decision: {body.decision}")

    claim = await db.claim_approval(body.run_id, "create_order", body.decision, user.user_id)
    if claim is None:
        approval = await db.get_approval(body.run_id)
        raise _approval_error(body.run_id, approval, "create_order")

    context = claim["approvalPayload"]

    if body.decision == "REJECTED":
        # Planning before approval means a PLANNED ProductionOrder may
        # already exist for a real MTO/CTO/HYBRID plan the human is now
        # rejecting — clean it up (order-service's real cascading delete)
        # so nothing lingers from a plan that was never approved. Nothing
        # else in the pre-approval plan wrote anything (the what-if
        # schedule simulation never touched Postgres, vendor sourcing
        # never created a trading order), so this is the only cleanup
        # needed.
        production_plan = context.get("production_plan") or {}
        production_order_id = production_plan.get("production_order_id")
        if production_order_id:
            try:
                await mfg.delete_production_order(production_order_id)
            except Exception:
                pass
        return {"resolved": True, "status": "REJECTED", "created": False}

    # APPROVED. quantity_override is the one legitimate client-supplied
    # field — a real, pre-existing "edit before approving" UX, applied on
    # top of the server's own stored context, not in place of it.
    effective_context = dict(context)
    if body.quantity_override is not None:
        effective_context["quantity"] = body.quantity_override

    outcome = execute_gated_action("create_order", effective_context)
    if not outcome["succeeded"]:
        reason = outcome["result"].get("reason", "Order creation failed.")
        await db.mark_execution_failed(body.run_id, {"error": reason})
        raise HTTPException(status_code=400, detail=reason)

    result = outcome["result"]

    # The order doesn't stop at "created" — same as the chat-only path,
    # it goes straight into the real fulfillment decision (MTS/MTO/CTO/
    # HYBRID/THIRD_PARTY) and, where that completes synchronously, a real
    # delivery + invoice. A failure here doesn't undo the order — it's
    # already a valid Sales Order — so this reports the gap honestly
    # rather than raising.
    try:
        fulfillment = await run_post_approval_fulfillment(
            effective_context, result["sales_order_id"], prefer_vendor=body.prefer_vendor
        )
    except Exception as exc:
        fulfillment = {"status": "FULFILLMENT_FAILED", "response": f"Fulfillment step raised: {exc}"}

    await db.mark_executed(body.run_id, {
        "sales_order_id": result["sales_order_id"],
        "production_order_id": fulfillment.get("production_order_id"),
    })

    return {
        "resolved": True,
        "status": "COMPLETED",
        "created": True,
        "sales_order_id": result["sales_order_id"],
        "sales_order_status": result["status"],
        "sales_order_total": result["total_amount"],
        "fulfillment_strategy": fulfillment.get("fulfillment_strategy"),
        "fulfillment_reasoning": fulfillment.get("fulfillment_reasoning"),
        "fulfillment_status": fulfillment.get("status"),
        "delivery_id": fulfillment.get("delivery_id"),
        "delivery_status": fulfillment.get("delivery_status"),
        "confirmed_delivery_date": fulfillment.get("confirmed_delivery_date"),
        "invoice_id": fulfillment.get("invoice_id"),
        "invoice_status": fulfillment.get("invoice_status"),
        "invoice_amount": fulfillment.get("invoice_amount"),
        "fulfillment_note": fulfillment.get("response"),
        "production_order_id": fulfillment.get("production_order_id"),
        "scheduled_operations": fulfillment.get("scheduled_operations"),
        "purchase_orders": fulfillment.get("purchase_orders"),
    }


# The conversational counterpart to Ledger's Reschedule/Optimize buttons
# (see sales_orders.py's own POST /{id}/reschedule) — both converge on the
# exact same mfg.reschedule_production_order() call, so there is one
# authoritative implementation of APS rescheduling regardless of which
# entry point triggered it. Nothing commits before this call — the
# preview graph.py's reschedule_request_node already showed (real target
# + real affected orders) is what a human is approving; REJECTED touches
# nothing, since the preview itself was read-only. Same atomic-claim
# protection as sales-order/resolve above — no client-supplied override
# exists for reschedule, so the server's stored payload is used exactly
# as proposed.
@router.post("/reschedule/resolve")
async def resolve_reschedule_approval(
    body: RescheduleApprovalRequest, user: ForwardedUser = Depends(require_role("PLANNER"))
):
    if body.decision not in ("APPROVED", "REJECTED"):
        raise HTTPException(status_code=400, detail=f"Invalid decision: {body.decision}")

    claim = await db.claim_approval(body.run_id, "RESCHEDULE_PRODUCTION", body.decision, user.user_id)
    if claim is None:
        approval = await db.get_approval(body.run_id)
        raise _approval_error(body.run_id, approval, "RESCHEDULE_PRODUCTION")

    ctx = claim["approvalPayload"]

    if body.decision == "REJECTED":
        return {"resolved": True, "status": "REJECTED"}

    try:
        result = await mfg.reschedule_production_order(ctx["plant_id"], ctx["production_order_id"], ctx["scope"], ctx["mode"])
    except Exception as exc:
        await db.mark_execution_failed(body.run_id, {"error": str(exc)})
        raise HTTPException(status_code=502, detail=f"Reschedule failed: {exc}")

    await db.mark_executed(body.run_id, {"production_order_id": ctx.get("production_order_id"), **result})

    return {
        "resolved": True,
        "status": "COMPLETED",
        "sales_order_id": ctx.get("sales_order_id"),
        "kind": ctx.get("kind"),
        **result,
    }
