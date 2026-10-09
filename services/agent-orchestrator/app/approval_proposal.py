# app/approval_proposal.py
"""Stage 04 — Immutable Proposal + Version-Bound Approval.

The canonical proposal continues to be AgentPipelineRun's own
approval* fields (requestedBy/approvalAction/approvalStatus/
approvalPayload/approvalExpiresAt/...) — per the task's own instruction
to reuse what already exists rather than introduce a second proposal
object. This module adds the two real pieces that were missing:

1. extract_executable_payload / compute_proposal_hash — a deterministic,
   LLM-prose-free hash of exactly the fields the real downstream mutation
   functions consume (see plan_executor.py's _run_create_order and
   graph.py's run_post_approval_fulfillment/resolve_reschedule_approval's
   replay of ctx). Hashing the FULL approvalPayload would hash informational
   preview arrays (materials/routing_operations/simulated_operations) and
   LLM reasoning text that are never resent to any real mutation — this
   hashes only what actually executes.

2. revalidate_proposal — re-reads the real, current state the proposal's
   decision depended on (customer active/credit, stock, the referenced
   ProductionOrder's continued existence) and reports back exactly what,
   if anything, has materially changed since the proposal was shown to a
   human. Called once, immediately before execution (approvals.py), never
   at proposal-creation time.
"""
import hashlib
import json

from app.integrations import manufacturing_services as mfg
from app.tools.credit_tools import check_credit
from app.tools.customer_tools import get_customer
from app.tools.inventory_tools import get_stock

# Keys that are either free-text LLM output (reasoning/explanation/
# configuration_notes/user_message) or purely-informational preview data
# never resent to any real mutation (materials/routing_operations/
# simulated_operations/procurement_plan — the only thing from
# production_plan actually replayed at execution time is
# production_order_id/plant_id/quantity, extracted explicitly below).
# Listed here once so both extract_executable_payload and any future
# caller agree on exactly what's excluded, instead of two independently
# maintained exclusion lists.
_LLM_PROSE_OR_INFORMATIONAL_KEYS = frozenset({
    "reasoning", "explanation", "configuration_notes", "user_message",
    "materials", "routing_operations", "simulated_operations", "procurement_plan",
    "stock", "can_produce", "product_configurable", "lead_time_days",
})


def _canonical_json(value) -> str:
    """Same recursive sorted-key canonicalization already used in TS
    (order-service/scheduling-service's canonicalJson) — two logically
    identical payloads must hash identically regardless of field-insertion
    order."""
    if isinstance(value, list):
        return "[" + ",".join(_canonical_json(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys())
        return "{" + ",".join(f"{json.dumps(k)}:{_canonical_json(value[k])}" for k in keys) + "}"
    return json.dumps(value)


def extract_executable_payload(action: str, context: dict) -> dict:
    """The structured subset of `context` that actually drives a real
    mutation for this action — never the full preview dict verbatim.
    Deterministic field set per action; an action with no known shape
    falls back to "everything except LLM prose/informational keys",
    rather than silently hashing nothing."""
    if action == "create_order":
        payload: dict = {
            "action": action,
            "customer_id": context.get("customer_id"),
            "customer_name": context.get("customer_name"),
            "customer_active": context.get("customer_active"),
            "product_id": context.get("product_id"),
            "product_name": context.get("product_name"),
            "quantity": context.get("quantity"),
            "price": context.get("price"),
            "requested_deadline": context.get("requested_deadline"),
        }
        fulfillment = context.get("fulfillment")
        if fulfillment:
            payload["fulfillment"] = {
                "strategy": fulfillment.get("strategy"),
                "from_stock": fulfillment.get("from_stock"),
                "to_produce": fulfillment.get("to_produce"),
            }
        production_plan = context.get("production_plan")
        if production_plan:
            payload["production_plan"] = {
                "production_order_id": production_plan.get("production_order_id"),
                "plant_id": production_plan.get("plant_id"),
                "quantity": production_plan.get("quantity"),
            }
        vendor_plan = context.get("vendor_plan")
        if vendor_plan:
            payload["vendor_plan"] = {
                "vendor_id": vendor_plan.get("vendor_id"),
                "vendor_name": vendor_plan.get("vendor_name"),
                "unit_cost": vendor_plan.get("unit_cost"),
                "lead_time_days": vendor_plan.get("lead_time_days"),
                "drop_ship": vendor_plan.get("drop_ship"),
            }
        return payload

    if action == "RESCHEDULE_PRODUCTION":
        # graph.py's reschedule_request_node already builds this context
        # as exactly the clean identifiers resolve_reschedule_approval
        # replays (sales_order_id/production_order_id/plant_id/kind/
        # scope/mode) — no LLM prose, no informational arrays, nothing to
        # filter out.
        return {"action": action, **context}

    # Unknown/future action — be honest about what's included rather than
    # inventing a shape: everything except the known prose/informational
    # keys, so a new gated action gets real coverage by default instead
    # of silently hashing an empty payload.
    return {
        "action": action,
        **{k: v for k, v in context.items() if k not in _LLM_PROSE_OR_INFORMATIONAL_KEYS},
    }


def compute_proposal_hash(action: str, context: dict) -> str:
    payload = extract_executable_payload(action, context)
    return hashlib.sha256(_canonical_json(payload).encode()).hexdigest()


async def revalidate_proposal(action: str, context: dict) -> list[str]:
    """Re-reads the real current state this proposal's decision depended
    on. Returns a list of human-readable reasons something has materially
    changed since the proposal was shown to a human — empty means still
    valid. Never mutates anything; purely a read-side check, run once,
    immediately before execution."""
    reasons: list[str] = []

    if action == "create_order":
        customer_name = context.get("customer_name")
        if customer_name:
            current_customer = get_customer(customer_name)
            if current_customer is None:
                reasons.append(f"Customer {customer_name!r} no longer resolvable.")
            elif current_customer["active"] != context.get("customer_active"):
                reasons.append(
                    f"Customer {customer_name!r} active status changed "
                    f"({context.get('customer_active')} -> {current_customer['active']})."
                )
            else:
                quantity = context.get("quantity") or 0
                price = context.get("price") or 0
                current_check = check_credit(
                    current_customer["customer_id"], current_customer["credit_limit"], quantity * price
                )
                if current_check["checked"] and not current_check["within_credit"]:
                    reasons.append(
                        f"Customer {customer_name!r} credit exposure changed — "
                        f"total exposure {current_check['total_exposure']} now exceeds "
                        f"the {current_check['credit_limit']} limit."
                    )

        fulfillment = context.get("fulfillment") or {}
        from_stock = fulfillment.get("from_stock") or 0
        product_id = context.get("product_id")
        if from_stock > 0 and product_id:
            current_stock_total = sum(row["stock_qty"] for row in get_stock(product_id))
            if current_stock_total < from_stock:
                reasons.append(
                    f"Stock for {context.get('product_name') or product_id} dropped below the "
                    f"{from_stock} this proposal's MTS/HYBRID stock leg requires "
                    f"(currently {current_stock_total})."
                )

        production_plan = context.get("production_plan") or {}
        production_order_id = production_plan.get("production_order_id")
        if production_order_id:
            try:
                current_order = await mfg.get_production_order(production_order_id)
            except Exception:
                reasons.append(f"Referenced ProductionOrder {production_order_id} could no longer be read.")
            else:
                if current_order.get("status") != "PLANNED":
                    reasons.append(
                        f"Referenced ProductionOrder {production_order_id} is no longer PLANNED "
                        f"(now {current_order.get('status')!r}) — it may have already been committed or removed."
                    )

    elif action == "RESCHEDULE_PRODUCTION":
        production_order_id = context.get("production_order_id")
        if production_order_id:
            try:
                current_order = await mfg.get_production_order(production_order_id)
            except Exception:
                reasons.append(f"Referenced ProductionOrder {production_order_id} no longer exists.")
            else:
                # Phase 16 (End-to-End Disruption Recovery Validation) —
                # real gap found: this branch only ever checked the order
                # was still readable, never whether the recovery it's
                # about to execute is still needed. Between proposal and
                # approval, the same production order's schedule can
                # already have moved on — repaired capacity, a separate
                # autoReschedule run, or a different approved recovery —
                # and if the committed schedule already meets the original
                # promise, executing this proposal anyway is at best a
                # redundant reschedule and at worst churns a schedule that
                # didn't need to change. Same comparison
                # _evaluate_reschedule_goal_satisfaction uses post-
                # execution, run here pre-execution instead.
                original_promised_date = context.get("original_promised_date")
                if original_promised_date:
                    scheduled_ops = current_order.get("scheduledOperations") or []
                    current_promised_date = max((op["scheduledEnd"] for op in scheduled_ops), default=None)
                    already_satisfied = (
                        current_promised_date is not None
                        and str(current_promised_date)[:10] <= str(original_promised_date)[:10]
                    )
                    if already_satisfied:
                        reasons.append(
                            f"ProductionOrder {production_order_id}'s current schedule already meets the "
                            f"original promise ({original_promised_date}) — this recovery proposal appears "
                            "moot; re-evaluate before executing a redundant reschedule."
                        )

    return reasons
