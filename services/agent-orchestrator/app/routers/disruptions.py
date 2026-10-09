# app/routers/disruptions.py
"""Phase 11 (Promise Monitoring & Agentic Recovery).

The one new entry point into agent-orchestrator that originates from a
scheduling-service DISRUPTION rather than a chat message. scheduling-
service (deterministic, no LLM — see its own checkPromiseImpact) has
already determined that a real customer promise was breached before this
endpoint is ever called; this endpoint's only job is to start a
promise-recovery reasoning episode for that one specific order, reusing
promise_reasoning_node (Phase 10) with a PROMISE_RECOVERY goal instead of
duplicating it as a new agent.

Mounted with the same app-wide require_service_token dependency every
other router already gets (see app/main.py) — scheduling-service calls
this exactly the way mes-integration already calls
/production-orders/{id}/complete.
"""
import logging

from fastapi import APIRouter, HTTPException

from app import db
from app.approval_proposal import compute_proposal_hash
from app.config import MANUFACTURING_PRODUCT_IDS
from app.graph import promise_reasoning_node
from app.integrations import manufacturing_services as mfg
from app.integrations.manufacturing_services import AGENT_ORCHESTRATOR_ENTERPRISE_ID
from app.schemas.disruption import DisruptionEvent
from app.trace_context import set_trace_id
from app.tools.product_tools import get_product

router = APIRouter(prefix="/disruptions")
logger = logging.getLogger(__name__)

# The reverse of config.py's own name->id map — built once, not per
# request. A real Postgres product id this codebase hasn't mapped to a
# sales-catalog product name has nothing here to resolve to; reported
# honestly (see below), never guessed at.
_PRODUCT_ID_TO_NAME = {v: k for k, v in MANUFACTURING_PRODUCT_IDS.items()}


@router.post("/evaluate")
async def evaluate_disruption(event: DisruptionEvent):
    set_trace_id(event.trace_id)

    product_name = _PRODUCT_ID_TO_NAME.get(event.product_id)
    product = get_product(product_name) if product_name else None
    if product is None:
        # Honest, non-fabricated failure (brief §13) — this product has no
        # real sales-catalog mapping, so there is nothing to reason about
        # with the existing capability set. Recorded, not silently dropped.
        logger.error(
            "Disruption event for production order %s: product %s has no sales-catalog mapping — cannot run promise recovery",
            event.production_order_id, event.product_id,
        )
        raise HTTPException(
            status_code=422,
            detail=f"Product {event.product_id} is not mapped to a sales-catalog product — cannot evaluate promise recovery.",
        )

    # Phase 16 — dedup BEFORE running the (expensive) reasoning episode:
    # the same real-world disruption can reach this endpoint more than
    # once (a redelivered Kafka message, or two disruption types hitting
    # the same resource close together — see db.has_pending_reschedule_
    # approval's own comment). A second pending recovery proposal for an
    # order that already has one open is never useful to the approver and
    # risks two separate executions if both are later approved — skip
    # reasoning entirely and report the existing one honestly instead of
    # silently creating a duplicate.
    if await db.has_pending_reschedule_approval(event.production_order_id, AGENT_ORCHESTRATOR_ENTERPRISE_ID):
        logger.info(
            "Disruption event %s for production order %s: a recovery proposal is already pending — skipping duplicate reasoning episode",
            event.event_id, event.production_order_id,
        )
        return {
            "run_id": None,
            "status": "DUPLICATE_SKIPPED",
            "event_id": event.event_id,
            "response": "A recovery proposal for this production order is already pending approval — not starting a duplicate.",
        }

    # Best-effort — only present for orders that went through the Phase
    # 10/approval flow (see app/routers/production.py's own identical
    # read of this same metadata field). None is a legitimate, honest
    # value; resolve_reschedule_approval's execution itself never needs
    # it (only plant_id/production_order_id/scope/mode do).
    sales_order_id: str | None = None
    try:
        production_order = await mfg.get_production_order(event.production_order_id)
        sales_order_id = (production_order.get("metadata") or {}).get("salesOrderId")
    except Exception:
        logger.warning("Could not re-read production order %s for sales_order_id", event.production_order_id, exc_info=True)

    run_id = await db.create_run()
    if run_id is None:
        # Same hard-failure principle pipeline.py's start_run already
        # applies to a chat-originated approval gate: a recovery proposal
        # reached with no run_id to durably bind it to cannot be safely
        # presented for approval at all.
        raise HTTPException(status_code=503, detail="Run tracking unavailable — cannot safely start a recovery reasoning episode.")

    state: dict = {
        "user_message": None,
        "customer_name": event.customer_name,
        "product_id": product["product_id"],
        "product_name": product["product_name"],
        "quantity": int(event.requested_quantity),
        "requested_deadline": event.requested_date,
        "promise_goal_type": "PROMISE_RECOVERY",
        "promise_disruption": {"type": event.disruption_type, "resource": event.affected_resource_id},
        "promise_current_result": {"promised_date": event.current_promised_date, "feasible": False},
        "promise_production_order_id": event.production_order_id,
        "promise_plant_id": event.plant_id,
        "promise_sales_order_id": sales_order_id,
    }

    try:
        result = await promise_reasoning_node(state)
    except Exception as exc:
        await db.finish_run(run_id, "FAILED")
        logger.error("Promise-recovery reasoning episode %s failed", run_id, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Promise-recovery reasoning failed: {exc}") from exc

    await db.log_stage(run_id, "promise_reasoning_recovery", {
        "event_id": event.event_id,
        "disruption_type": event.disruption_type,
        "production_order_id": event.production_order_id,
        **{k: v for k, v in result.items() if k != "pending_approval"},
    })

    pending = result.get("pending_approval")
    if pending is not None:
        await db.save_pending_approval(
            run_id=run_id,
            action=pending["action"],
            payload=pending["context"],
            requested_by="SYSTEM:disruption-monitor",
            enterprise_id=AGENT_ORCHESTRATOR_ENTERPRISE_ID,
            proposal_hash=compute_proposal_hash(pending["action"], pending["context"]),
        )
        await db.finish_run(run_id, "COMPLETED")
        return {"run_id": run_id, "status": "AWAITING_APPROVAL", "event_id": event.event_id}

    await db.finish_run(run_id, "COMPLETED")
    return {"run_id": run_id, "status": result.get("status", "COMPLETED"), "event_id": event.event_id, "response": result.get("response")}
