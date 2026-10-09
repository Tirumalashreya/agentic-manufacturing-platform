# app/routers/approvals.py
import logging

from fastapi import APIRouter, Depends, HTTPException

from app import db
from app.approval_proposal import compute_proposal_hash, revalidate_proposal
from app.graph import run_post_approval_fulfillment
from app.integrations import manufacturing_services as mfg
from app.integrations.manufacturing_services import AGENT_ORCHESTRATOR_ENTERPRISE_ID
from app.security import ForwardedUser, require_role
from app.tools.financial_tools import (
    list_actionable_financial_adjustments,
    post_financial_adjustment,
    resolve_financial_approval,
)
from app.tools.plan_executor import execute_gated_action
from app.trace_context import set_trace_id
from pydantic import BaseModel

router = APIRouter(prefix="/approvals")
logger = logging.getLogger(__name__)

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


# Phase 10 (Agentic Order Promise & Scenario Reasoning), brief §11 — "do
# not simply set COMPLETED because the API call returned 200." Additive
# only: every existing create_order approval already carries `quantity`/
# `requested_deadline` in its context (composed_execution_node has always
# populated both), so this runs for the pre-existing flow too, not only
# promise_reasoning_node's — it just had nothing checking it until now.
# Never gates anything; purely a reported, deterministic fact.
def _evaluate_goal_satisfaction(context: dict, fulfillment: dict) -> dict:
    requested_quantity = context.get("quantity")
    requested_date = context.get("requested_deadline")
    fulfillment_block = context.get("fulfillment") or {}
    fulfilled_quantity = (fulfillment_block.get("from_stock") or 0) + (fulfillment_block.get("to_produce") or 0)
    promised_date = fulfillment.get("confirmed_delivery_date")

    quantity_satisfied = requested_quantity is not None and fulfilled_quantity == requested_quantity
    date_satisfied: bool | None = None
    if requested_date and promised_date:
        date_satisfied = str(promised_date)[:10] <= str(requested_date)[:10]
    elif requested_date and not promised_date:
        date_satisfied = False

    fulfillment_status = str(fulfillment.get("status") or "")
    no_conflicts = "FAILED" not in fulfillment_status

    return {
        "requested_quantity": requested_quantity,
        "fulfilled_quantity": fulfilled_quantity,
        "requested_date": requested_date,
        "promised_date": promised_date,
        "quantity_satisfied": quantity_satisfied,
        "date_satisfied": date_satisfied,
        "satisfied": bool(quantity_satisfied and date_satisfied is not False and no_conflicts),
    }


# Phase 11 — the recovery-specific counterpart to _evaluate_goal_satisfaction
# above, for a committed reschedule rather than a new order. Returns None
# (not False) when this wasn't a recovery proposal at all (no
# original_promised_date on the context) — the plain chat-driven reschedule
# path has nothing to verify a promise against, and reporting a
# goal_satisfaction block there would imply a promise existed when none did.
async def _evaluate_reschedule_goal_satisfaction(ctx: dict) -> dict | None:
    original_promised_date = ctx.get("original_promised_date")
    production_order_id = ctx.get("production_order_id")
    if not original_promised_date or not production_order_id:
        return None

    try:
        order = await mfg.get_production_order(production_order_id)
    except Exception as exc:
        logger.warning("Could not re-read production order %s for post-recovery goal check: %s", production_order_id, exc)
        return {
            "requested_quantity": ctx.get("requested_quantity"),
            "fulfilled_quantity": None,
            "requested_date": original_promised_date,
            "promised_date": None,
            "satisfied": False,
        }

    scheduled_ops = order.get("scheduledOperations") or []
    new_promised_date = max((op["scheduledEnd"] for op in scheduled_ops), default=None)

    date_satisfied = new_promised_date is not None and str(new_promised_date)[:10] <= str(original_promised_date)[:10]

    return {
        "requested_quantity": ctx.get("requested_quantity"),
        "fulfilled_quantity": order.get("quantity"),
        "requested_date": original_promised_date,
        "promised_date": new_promised_date,
        "satisfied": bool(date_satisfied),
    }


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
    'never existed' and 'wrong enterprise' are never collapsed into the
    same generic failure."""
    if approval is None:
        return HTTPException(status_code=404, detail=f"No approval found for run {run_id}")
    if approval["approvalAction"] != expected_action:
        return HTTPException(
            status_code=400,
            detail=f"Run {run_id} is not awaiting a {expected_action} approval (found {approval['approvalAction']!r})",
        )
    # Stage 04 (§4/§5): checked before status, since an enterprise mismatch
    # is the more specific, more serious reason a claim can fail even when
    # the row is genuinely still PENDING — collapsing it into a generic
    # "not awaiting a decision" would hide a real cross-tenant access
    # attempt behind an ordinary-looking retry error.
    if approval.get("enterpriseId") is not None and approval["enterpriseId"] != AGENT_ORCHESTRATOR_ENTERPRISE_ID:
        return HTTPException(
            status_code=403,
            detail=f"Run {run_id} belongs to a different enterprise — this approver cannot act on it.",
        )
    status = approval["approvalStatus"]
    if status == "EXPIRED":
        return HTTPException(status_code=410, detail=f"Approval for run {run_id} has expired — request a new one.")
    if status == "STALE":
        return HTTPException(
            status_code=409,
            detail=f"Approval for run {run_id} went stale before execution — submit a new request for a fresh proposal.",
        )
    if status in ("APPROVED", "REJECTED", "CONSUMED"):
        return HTTPException(
            status_code=409,
            detail=f"Approval for run {run_id} was already resolved (status: {status}) — it cannot be actioned again.",
        )
    return HTTPException(status_code=409, detail=f"Approval for run {run_id} is not awaiting a decision (status: {status}).")


# Stage 04 (§3/§5/§6) — run once, immediately before execution, for every
# gated action: recompute the proposal hash from the server-stored
# payload and compare it to what was recorded at proposal time (an
# integrity check — nothing in this codebase modifies approvalPayload
# after save_pending_approval, so a mismatch would mean something new,
# unaccounted-for, touched it), then re-read the real current business
# state the decision depended on. Either kind of problem gets the exact
# same treatment: do not execute, flip APPROVED -> STALE, and tell the
# caller plainly why. Returns None when the proposal is still good to
# execute.
async def _revalidate_or_stale(run_id: str, action: str, context: dict, stored_hash: str | None) -> HTTPException | None:
    reasons: list[str] = []
    if stored_hash is not None and compute_proposal_hash(action, context) != stored_hash:
        reasons.append("Proposal payload no longer matches its own recorded hash (integrity check failed).")
    reasons.extend(await revalidate_proposal(action, context))
    if not reasons:
        return None
    await db.mark_stale(run_id, reasons)
    logger.warning("Approval for run %s went stale before execution: %s", run_id, "; ".join(reasons))
    return HTTPException(
        status_code=409,
        detail={"error": "Proposal is stale — submit a new request for a fresh proposal.", "reasons": reasons},
    )


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

    claim = await db.claim_approval(body.run_id, "create_order", body.decision, user.user_id, AGENT_ORCHESTRATOR_ENTERPRISE_ID)
    if claim is None:
        approval = await db.get_approval(body.run_id)
        raise _approval_error(body.run_id, approval, "create_order")

    # Phase 17 (Production Readiness & Observability) — real gap found: the
    # proposal/investigation phase (pipeline.py's start_run, disruptions.py's
    # evaluate_disruption) already sets a trace_id every outbound call during
    # that phase carries; this later, separate HTTP request (a human clicking
    # Approve) started with none, so every call this function makes from here
    # on — order-service, downstream sync — was unlinked from the run an
    # operator would actually be grepping logs for. run_id is already the
    # real, stable, unique key for this whole saga; reusing it needs no new
    # id or storage.
    set_trace_id(body.run_id)

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
        cleanup_warning = None
        if production_order_id:
            try:
                await mfg.delete_production_order(production_order_id)
            except Exception as exc:
                # Stage 01 (Fail Loud, Fail Closed): the rejection itself is
                # already real and committed (db.claim_approval above) — a
                # failed cleanup must not be reported as if it silently
                # succeeded, but it also must not be reported as the
                # rejection having failed, since it didn't. Logged with full
                # context and surfaced on the response; the stale
                # ProductionOrder is left for manual/operational follow-up
                # rather than invented retry machinery.
                logger.error(
                    "Cleanup failed: stale ProductionOrder %s was not deleted after rejecting run %s",
                    production_order_id, body.run_id, exc_info=True,
                )
                cleanup_warning = (
                    f"Order rejected, but cleanup of the draft ProductionOrder {production_order_id} failed: {exc}"
                )
        return {
            "resolved": True,
            "status": "REJECTED",
            "created": False,
            **({"cleanup_warning": cleanup_warning} if cleanup_warning else {}),
        }

    # Stage 04 (§3/§5/§6): revalidate against the UNMODIFIED stored
    # context — the hash was computed from exactly this at proposal time,
    # and quantity_override (below) is a deliberate, already-approved
    # deviation, not something that should ever look like tampering.
    stale_error = await _revalidate_or_stale(body.run_id, "create_order", context, claim.get("proposalHash"))
    if stale_error is not None:
        raise stale_error

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
            effective_context, result["sales_order_id"], prefer_vendor=body.prefer_vendor, run_id=body.run_id
        )
    except Exception as exc:
        fulfillment = {"status": "FULFILLMENT_FAILED", "response": f"Fulfillment step raised: {exc}"}

    # Phase 14 (Promise Risk & Decision Inbox) — computed BEFORE
    # mark_executed now (previously only returned over HTTP, never
    # durably stored) so the inbox's own read of AgentPipelineRun.
    # executionResult has a real, verified post-execution outcome to show
    # for "was this order's promise actually restored," not just
    # whatever the approval response happened to say at the time.
    goal_satisfaction = _evaluate_goal_satisfaction(effective_context, fulfillment)

    await db.mark_executed(body.run_id, {
        "sales_order_id": result["sales_order_id"],
        "production_order_id": fulfillment.get("production_order_id"),
        "goal_satisfaction": goal_satisfaction,
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
        "goal_satisfaction": goal_satisfaction,
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

    claim = await db.claim_approval(
        body.run_id, "RESCHEDULE_PRODUCTION", body.decision, user.user_id, AGENT_ORCHESTRATOR_ENTERPRISE_ID
    )
    if claim is None:
        approval = await db.get_approval(body.run_id)
        raise _approval_error(body.run_id, approval, "RESCHEDULE_PRODUCTION")

    # Phase 17 — same reasoning as resolve_sales_order_approval above: this
    # is the approval/execution phase of a disruption-recovery saga that
    # began in evaluate_disruption with its own trace_id, but this request
    # is a fresh HTTP call (a human clicking Approve) that starts with none
    # of its own — reusing run_id here is what lets an operator follow one
    # disruption from first detection through to the executed reschedule
    # in the logs, across both services.
    set_trace_id(body.run_id)

    ctx = claim["approvalPayload"]

    if body.decision == "REJECTED":
        return {"resolved": True, "status": "REJECTED"}

    stale_error = await _revalidate_or_stale(body.run_id, "RESCHEDULE_PRODUCTION", ctx, claim.get("proposalHash"))
    if stale_error is not None:
        raise stale_error

    try:
        result = await mfg.reschedule_production_order(ctx["plant_id"], ctx["production_order_id"], ctx["scope"], ctx["mode"])
    except Exception as exc:
        await db.mark_execution_failed(body.run_id, {"error": str(exc)})
        raise HTTPException(status_code=502, detail=f"Reschedule failed: {exc}")

    # Phase 11 (brief §14, "Observe After Recovery") — reschedule_production_order's
    # own result (operationsScheduled/conflictsDetected/scheduleVersion)
    # says the API call succeeded; it says nothing about whether the
    # specific order a recovery was trying to protect actually got its
    # promise back. original_promised_date/requested_quantity only ever
    # exist on a PROMISE_RECOVERY-originated proposal (see graph.py's
    # _run_promise_recovery_scenarios) — the plain chat-driven reschedule
    # path (reschedule_request_node) never sets them, so this stays None
    # there, exactly as before this phase (no behavior change for that path).
    goal_satisfaction = await _evaluate_reschedule_goal_satisfaction(ctx)

    # Phase 14 — durably stored now (previously only returned over HTTP),
    # so the inbox can read "was this recovery actually verified" from
    # AgentPipelineRun.executionResult rather than nowhere at all.
    await db.mark_executed(body.run_id, {
        "production_order_id": ctx.get("production_order_id"), **result, "goal_satisfaction": goal_satisfaction,
    })

    return {
        "resolved": True,
        "status": "COMPLETED",
        "sales_order_id": ctx.get("sales_order_id"),
        "kind": ctx.get("kind"),
        **result,
        **({"goal_satisfaction": goal_satisfaction} if goal_satisfaction is not None else {}),
    }
