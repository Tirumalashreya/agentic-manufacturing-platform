# app/graph.py
import logging
import os
import re

from langgraph.graph import StateGraph, START, END

from app.schemas.state import SalesState
from app.agents.intent_agent import intent_agent
from app.agents.context_agent import context_agent
from app.agents.process_agent import process_agent
from app.agents.quotation_agent import quotation_agent
from app.agents.fulfillment_agent import fulfillment_agent
from app.agents.configuration_agent import configuration_agent
from app.agents.billing_agent import billing_agent
from app.agents.post_sales_agent import post_sales_agent
from app.agents.procurement_agent import procurement_agent
from app.agents.production_planning_agent import production_planning_agent
from app.agents.inventory_agent import inventory_agent
from app.agents.quality_agent import quality_agent
from app.integrations import manufacturing_services as mfg
from app.integrations import order_domain
from app.agents.service_agent import service_agent
from app.agents.subscription_agent import subscription_agent
from app.agents.project_agent import project_agent
from app.agents.export_agent import export_agent
from app.agents.consignment_agent import consignment_agent
from app.agents.financial_agent import financial_agent
from app.agents.request_understanding_agent import request_understanding_agent
from app.schemas.understanding import EntityReference
from app.tools.reference_resolution import resolve_reference
from app.tools.plan_executor import execute_action_plan, plan_targets_order_creation
from groq import BadRequestError
from app.erp.factory import default_erp_adapter as erp
from app.tools.sales_tools import create_quotation, update_sales_order_status
from app.tools.service_tools import create_service_order
from app.tools.subscription_tools import (
    create_subscription,
    find_subscription_plan,
    find_active_subscription,
    renew_subscription,
    cancel_subscription,
)
from app.tools.fulfillment_tools import compute_fulfillment_split
from app.tools.production_tools import compute_target_completion_date
from app.tools.post_sales_tools import process_post_sales_action, find_sales_order
from app.tools.trading_tools import (
    create_trading_order,
    find_trading_order,
    mark_trading_order_delivered,
    mark_trading_order_dispatched,
)
from app.tools.project_tools import attach_production_order, create_project
from app.tools.export_tools import create_export_order, find_export_order, set_export_fulfillment
from app.tools.consignment_tools import create_consignment
from app.tools.financial_tools import (
    FINANCIAL_APPROVAL_THRESHOLD,
    create_financial_adjustment,
    post_financial_adjustment,
)

logger = logging.getLogger(__name__)


async def intent_node(state: SalesState):
    result = await intent_agent(state["user_message"])

    return {
        "intent": result.intent,
        "customer": result.customer,
        "product": result.product,
        "quantity": result.quantity,
        "requested_deadline": result.requested_deadline,
        "needs_clarification": result.needs_clarification,
        "clarification_question": result.clarification_question,
    }


# Deterministic conditional edge — intent_agent already decided whether it
# has enough to proceed; this just acts on that instead of silently
# ignoring it and letting missing data fail deep in the pipeline with a
# far less helpful error.
def intent_router(state: SalesState) -> str:
    if state["needs_clarification"]:
        return "needs_clarification"
    return "context"


async def needs_clarification_node(state: SalesState):
    return {
        "status": "NEEDS_CLARIFICATION",
        "response": state["clarification_question"] or "More information is needed to process this request.",
    }


# Phase 1 of the dynamic-ERP roadmap (agreed with the user): runs
# alongside the existing Intent/Context/Process pipeline, not instead of
# it — this node changes nothing about how a request is classified. It
# only captures what IntentResult throws away (constraints, explicit
# requested actions) and gives entry_router a narrow, specific signal
# (see entry_router below) for one demonstrated failure mode: a request
# that's clearly about acquiring/building something getting forced into
# FINANCIAL just because the product wasn't recognized.
async def understanding_node(state: SalesState):
    result = await request_understanding_agent(state["user_message"])
    return {
        "request_goal": result.goal,
        "request_constraints": result.constraints,
        "request_actions": result.requested_actions,
        "mentions_product_or_service": result.mentions_product_or_service,
        "mentions_financial_adjustment": result.mentions_financial_adjustment,
        "is_supported": result.is_supported,
        # Carried through for visibility only (trace page, direct
        # inspection) — nothing routes on this yet. Resolving a reference
        # against real records is deliberately a separate, not-yet-built
        # step (see app/tools/entity_resolver.py's own docstring).
        "request_references": [r.model_dump() for r in result.references],
        # Visibility only, same as request_references above — no execution
        # reads this (see RequestedAction's docstring).
        "request_action_plan": [a.model_dump() for a in result.action_plan],
    }


# Deterministic conditional edge, same pattern as entry_router/credit_router
# — the LLM judgment already happened inside understanding_node; this just
# acts on it. Short-circuits BEFORE context/process run at all: an
# unsupported request (e.g. "arrange financing for this customer") gains
# nothing from an ERP lookup or a forced process classification, so this
# saves both the extra calls and the risk of process_agent inventing a
# plausible-sounding but wrong bucket for something that fits none of them.
def understanding_router(state: SalesState) -> str:
    if not state["is_supported"]:
        return "unsupported"
    return "context"


# Phase 2 step 2.2b (agreed with the user): runs resolve_reference() over
# every reference understanding_node extracted. Purely additive — no
# existing routing, agent, or workflow reads resolved_references, so this
# cannot change behavior for any request that worked before it existed.
# An unresolved reference deliberately does NOT trigger clarification
# here; that would be a real behavior change and needs its own evidence
# first, per the standing rule this session keeps to.
async def reference_resolution_node(state: SalesState):
    references = [EntityReference(**r) for r in state.get("request_references", [])]
    resolved = [
        {"reference": r.model_dump(), **resolve_reference(r)}
        for r in references
    ]
    return {"resolved_references": resolved}


# Distinct from unclear_node on purpose (see RequestUnderstanding.is_supported):
# UNCLEAR means "this is a real ERP request but I'm missing/can't match
# something" — worth asking a follow-up question. UNSUPPORTED means "this
# isn't something Ledger does at all" — no follow-up question would help,
# so this doesn't pretend to be a clarification.
async def unsupported_node(state: SalesState):
    return {
        "status": "UNSUPPORTED",
        "response": (
            f"I understood you want to: {state['request_goal']} — but that's not something "
            f"this system can help with. Ledger handles sales orders, quotes, returns, service "
            f"requests, subscriptions, projects, exports, consignments, and financial "
            f"adjustments — not this."
        ),
    }


# The human-in-the-loop escape hatch entry_router routes to instead of
# forcing a request into FINANCIAL: same shape as needs_clarification_node
# (needs_clarification / clarification_question / status /response) so it
# reuses the existing ClarificationCard + resubmit flow the frontend
# already has for intent_agent's own clarification questions — no new UI
# mechanism, just a second, later point the same pause can trigger from.
async def unclear_node(state: SalesState):
    question = (
        f"I understood you want to: {state['request_goal']} — but I couldn't match this to "
        f"a specific product in our catalog, so I can't process it as a financial adjustment "
        f"or a standard order. Could you confirm the exact product name or item you need?"
    )
    return {
        "needs_clarification": True,
        "clarification_question": question,
        "status": "NEEDS_CLARIFICATION",
        "response": question,
    }


async def context_node(state: SalesState):
    result = await context_agent(state["customer"], state["product"])

    return {
        "customer_id": result.customer_id,
        "customer_name": result.customer_name,
        "customer_exists": result.customer_exists,
        "customer_active": result.customer_active,
        "product_id": result.product_id,
        "product_name": result.product_name,
        "product_valid": result.product_valid,
        "price": result.price,
        "stock": [s.model_dump() for s in result.stock],
        "can_produce": result.can_produce,
        "product_configurable": result.product_configurable,
        "lead_time_days": result.lead_time_days,
        "customer_credit_limit": result.customer_credit_limit,
    }


# Reachable whenever the extracted plan intends to create an order at
# all — see plan_executor.plan_targets_order_creation. This used to
# require 2+ steps AND every action label be recognized, which meant a
# single unrecognized label anywhere in the plan (e.g. an LLM
# paraphrasing "check everything" instead of naming check_credit/
# check_stock explicitly) sent the whole request down the old,
# ungated direct_sales path — silently creating the order with no human
# approval step at all, regardless of what the customer actually asked
# for. The human-approval guarantee has to hold for any order-creating
# request, not just ones phrased in the one shape that happens to
# extract a clean 2-action plan; plan_executor._normalize_plan is what
# then guarantees check_credit/check_stock actually run before the
# approval gate, independent of what else was (or wasn't) in the plan.
# This is still not a general planner: adding a new composable action
# means adding a new allow-list entry in plan_executor.py, a deliberate,
# reviewable change, not something a model can expand at runtime.
def composed_execution_router(state: SalesState) -> str:
    if _classify_reschedule_request(state.get("user_message"), state.get("request_actions") or []):
        return "reschedule_request"
    # Real bug found live (agreed with the user): this used to run the
    # loose "stock"/"inventory" keyword check *before* checking real
    # order-creation intent — so any order request phrased "check their
    # credit and stock" (the Sales Ledger's own BookingComposer.tsx always
    # generates exactly this wording, and it's this app's own suggested
    # example prompt in Agent Console) got hijacked into a bare shortage
    # scan and never reached credit check / stock check / approval at all.
    # plan_targets_order_creation is the strong, reliable signal (real
    # Intent Agent classification, or an actual create_order plan step) —
    # checked first now, so a genuine order request always wins over the
    # keyword heuristic. A standalone "What's our inventory status?" still
    # falls through correctly: it has no order-creation intent or plan.
    plan = state.get("request_action_plan") or []
    if plan_targets_order_creation(plan, state.get("intent")):
        return "composed_execution"
    if _classify_inventory_or_quality_request(state.get("user_message"), state.get("request_actions") or []):
        return "inventory_quality_request"
    return "process"


# Real, keyword-based classification (agreed with the user) — deliberately
# NOT routed through request_action_plan: that field is only populated for
# genuinely multi-step/conditional requests (per request_understanding_agent's
# own instructed convention — "order 10 mice" gets action_plan: [], same as
# a bare "reschedule SO0001" would), so a single-action reschedule request
# would never reach composed_execution_router's existing plan-based check.
# request_actions (the flat list, populated for any explicit single action)
# plus the raw user_message are matched against real keywords instead —
# simple, deterministic, and not dependent on the LLM picking one exact
# action label. "optimize" is checked first since a request combining both
# words ("reschedule to optimize this order") should get the broader,
# honestly-labeled AFFECTED action, not the narrower SINGLE one.
def _classify_reschedule_request(user_message: str | None, request_actions: list[str]) -> str | None:
    haystack = " ".join([user_message or "", *request_actions]).lower()
    if "optimize" in haystack or "optimise" in haystack:
        return "optimize"
    if "reschedule" in haystack:
        return "reschedule"
    return None


# scope/mode decisions mirror sales_orders.py's _RESCHEDULE_KINDS exactly
# (agreed with the user — both entry points must agree) — never ALL,
# never a raw passthrough scope.
_RESCHEDULE_KIND_TO_ACTION = {
    "reschedule": {"scope": "SINGLE", "mode": "FORWARD"},
    "optimize": {"scope": "AFFECTED", "mode": "BOTTLENECK"},
}


# The conversational trigger (agreed with the user) — "reschedule SO-1045"
# or "optimize SO-1045" reaches this node instead of composed_execution/
# process. Converges on the exact same mfg.reschedule_production_order()
# the Ledger UI button calls (see sales_orders.py) — this node NEVER
# calls scheduling-service or APS Platform directly, only through
# manufacturing_services.py's APSAgentClient, so there is one
# authoritative implementation regardless of which entry point triggered
# it. Nothing commits here — this only builds a real preview (via the
# same resolveScopedOrderIds() the committing run itself uses) and
# returns a pending_approval; execution happens only after a human
# approves via POST /approvals/reschedule/resolve, the same
# nothing-commits-before-approval guarantee create_order already has.
async def reschedule_request_node(state: SalesState):
    kind = _classify_reschedule_request(state.get("user_message"), state.get("request_actions") or [])

    target_sales_order = None
    for ref in state.get("resolved_references") or []:
        if ref.get("reference", {}).get("entity_type") == "sales_order" and ref.get("status") == "RESOLVED":
            target_sales_order = ref.get("resolved_record")
            break

    if target_sales_order is None:
        question = "Which sales order would you like to reschedule or optimize? Please include its ID, e.g. SO0001."
        return {
            "needs_clarification": True,
            "clarification_question": question,
            "status": "NEEDS_CLARIFICATION",
            "response": question,
        }

    sales_order_id = target_sales_order["sales_order_id"]
    production_order_summary = await mfg.find_production_order_by_sales_order(sales_order_id)
    if production_order_summary is None:
        response = f"{sales_order_id} has no linked production order — nothing to reschedule."
        return {"status": "COMPLETED", "response": response}

    plant_id = production_order_summary.get("plantId") or MANUFACTURING_PLANT_ID
    action = _RESCHEDULE_KIND_TO_ACTION[kind]
    preview = await mfg.get_affected_orders_preview(plant_id, production_order_summary["id"], action["scope"])
    scoped_ids = preview.get("scopedOrderIds") or []
    affected_count = max(len(scoped_ids) - 1, 0)

    pending_context = {
        "sales_order_id": sales_order_id,
        "production_order_id": production_order_summary["id"],
        "plant_id": plant_id,
        "kind": kind,
        "scope": action["scope"],
        "mode": action["mode"],
    }
    summary = (
        f"Ready to {kind} {sales_order_id} — scope {action['scope']}"
        + (f", affecting {affected_count} other order(s) sharing its work centers" if affected_count > 0 else "")
        + ". Nothing has been changed yet — awaiting your approval."
    )
    return {
        "status": "AWAITING_APPROVAL",
        "response": summary,
        "pending_approval": {
            "action": "RESCHEDULE_PRODUCTION",
            "context": pending_context,
            "preview": {
                "sales_order_id": sales_order_id,
                "kind": kind,
                "scope": action["scope"],
                "mode": action["mode"],
                "target_order_id": preview.get("targetOrderId"),
                "affected_order_ids": scoped_ids,
                "affected_count": affected_count,
            },
        },
    }


# Real, keyword-based classification (Phase 8, agreed with the user) —
# mirrors _classify_reschedule_request exactly, the one existing precedent
# for adding a conversational trigger outside the 9-value entry_type
# system. "delay"/"late" is checked first since a delay question names a
# specific order and is the most specific ask; "quality" next; "shortage"/
# "stock"/"inventory" last. All three are genuinely read-only — nothing
# here ever reaches an approval gate, unlike reschedule/create_order.
def _classify_inventory_or_quality_request(user_message: str | None, request_actions: list[str]) -> str | None:
    haystack = " ".join([user_message or "", *request_actions]).lower()
    # "late" needs a real word boundary — a plain substring check would
    # misfire on "escalate", "translate", etc. "delay"/"quality"/etc. are
    # distinctive enough as plain substrings, matching this codebase's
    # existing _classify_reschedule_request precedent.
    if "delay" in haystack or re.search(r"\blate\b", haystack) or "behind schedule" in haystack:
        return "delay"
    if "quality" in haystack or "inspection" in haystack or "defect" in haystack or re.search(r"\bqc\b", haystack):
        return "quality"
    if "shortage" in haystack or "stock" in haystack or "inventory" in haystack:
        return "shortages"
    return None


# Deliberately NOT an LLM call (agreed with the user, per rule 8's emphasis
# on never inventing numbers/schedules) — get_delay_explanation already
# assembles every real fact (audit history, exceptions, QC holds, deviation
# minutes); this only formats them. A templated summary carries zero risk
# of fabricating a reason the real data doesn't support, which a delay
# explanation — combining the most real facts of any capability this round
# adds — is the one place that risk is highest.
def _format_delay_explanation(sales_order_id: str, data: dict) -> str:
    status = data.get("latenessStatus", "NO_DUE_DATE")
    due = data.get("dueDate")
    header = f"{sales_order_id} is {status}" + (f" (due {due})" if due else " (no due date on file)") + "."

    reasons: list[str] = []
    for op in data.get("operations") or []:
        op_name = op.get("operation") or "an operation"
        hold = op.get("qcHold")
        if hold and hold.get("blocked"):
            reasons.append(f"{op_name} is blocked on a QC hold ({hold.get('reason')}).")
        for exc in op.get("recentExceptions") or []:
            if exc.get("resolvedAt") is None:
                reasons.append(f"{op_name} has an open {exc.get('type')} exception reported {exc.get('reportedAt')}.")
        deviation = op.get("deviationMinutes")
        if deviation and deviation > 0:
            reasons.append(f"{op_name} finished {deviation} minute(s) later than scheduled.")

    for row in (data.get("auditHistory") or [])[:3]:
        reason = (row.get("after") or {}).get("reason") or (row.get("before") or {}).get("reason")
        if reason:
            reasons.append(f"Rescheduled: {reason}.")

    if not reasons:
        reasons.append("No open exceptions, QC holds, or recorded reschedules were found for this order.")

    return header + " " + " ".join(reasons)


# The conversational trigger for Inventory/Quality read-only questions
# (Phase 8, agreed with the user) — "what's our inventory status", "did the
# last batch pass inspection", "why is SO0004 delayed" reach this node
# instead of composed_execution/process. Every branch here is strictly
# read-only: no DB writes, no approval gate (matching capacity_status/
# resolve_affected_orders, the existing real APSAgentClient reads that also
# require none) — the new inventory_agent/quality_agent only explain real
# facts computed elsewhere, never compute anything themselves.
async def inventory_quality_request_node(state: SalesState):
    kind = _classify_inventory_or_quality_request(state.get("user_message"), state.get("request_actions") or [])

    if kind == "shortages":
        result = await mfg.check_shortages()
        decision = await inventory_agent(result.get("shortages") or [])
        return {"status": "COMPLETED", "response": decision.explanation}

    if kind == "quality":
        result = await mfg.get_quality_inspections(MANUFACTURING_PLANT_ID)
        decision = await quality_agent(result.get("items") or [], None)
        return {"status": "COMPLETED", "response": decision.explanation}

    # kind == "delay" — needs a specific order, same resolution machinery
    # reschedule_request_node already uses (resolved_references, populated
    # by the existing reference_resolution/context nodes).
    target_sales_order = None
    for ref in state.get("resolved_references") or []:
        if ref.get("reference", {}).get("entity_type") == "sales_order" and ref.get("status") == "RESOLVED":
            target_sales_order = ref.get("resolved_record")
            break

    if target_sales_order is None:
        question = "Which sales order would you like a delay explanation for? Please include its ID, e.g. SO0001."
        return {
            "needs_clarification": True,
            "clarification_question": question,
            "status": "NEEDS_CLARIFICATION",
            "response": question,
        }

    sales_order_id = target_sales_order["sales_order_id"]
    production_order_summary = await mfg.find_production_order_by_sales_order(sales_order_id)
    if production_order_summary is None:
        response = f"{sales_order_id} has no linked production order — nothing to explain yet."
        return {"status": "COMPLETED", "response": response}

    explanation = await mfg.get_delay_explanation(production_order_summary["id"])
    if explanation.get("not_found"):
        response = f"{sales_order_id}'s production order could not be found on the manufacturing side."
        return {"status": "COMPLETED", "response": response}

    response = _format_delay_explanation(sales_order_id, explanation)
    return {"status": "COMPLETED", "response": response}


async def composed_execution_node(state: SalesState):
    context = {
        "customer_id": state.get("customer_id"),
        "customer_name": state.get("customer_name"),
        "customer_active": state.get("customer_active"),
        "customer_credit_limit": state.get("customer_credit_limit"),
        "product_id": state.get("product_id"),
        "product_name": state.get("product_name"),
        "quantity": state.get("quantity"),
        "price": state.get("price"),
        "requested_deadline": state.get("requested_deadline"),
        # Not used by check_credit/check_stock/create_order themselves —
        # carried through so an APPROVED create_order can continue into
        # the real fulfillment_decision_node -> MTS/MTO/CTO/... chain
        # afterward (see run_post_approval_fulfillment), instead of
        # dead-ending at "order created" the way this path used to.
        "can_produce": state.get("can_produce"),
        "product_configurable": state.get("product_configurable"),
        "lead_time_days": state.get("lead_time_days"),
        "stock": state.get("stock"),
        "user_message": state.get("user_message"),
    }
    result = execute_action_plan(state["request_action_plan"], context, state.get("intent"))

    update: dict = {
        # Labeled distinctly from the 9 real entry_type values on
        # purpose — this did NOT go through process_agent's
        # classification at all, and pretending it did would misrepresent
        # how the request was actually handled.
        "entry_type": "COMPOSED_PLAN",
        "status": result["status"],
    }

    stock_checked = False
    credit_unresolvable = False
    for step in result["executed"]:
        if step["action"] == "check_credit":
            # check_credit() returns checked=False (not a failed check,
            # an *unperformed* one) when there's no known customer/credit
            # limit to check against at all — see credit_tools.py. A
            # bug found live: this used to report that identically to a
            # real "checked, and over the limit" failure, so an unknown
            # customer showed up as "over credit limit" with None-filled
            # exposure figures instead of the honest "can't verify — no
            # such customer" reason.
            if step["result"].get("checked", True):
                update["credit_checked"] = True
                update["credit_within_limit"] = step["succeeded"]
                update["credit_existing_exposure"] = step["result"].get("existing_exposure")
                update["credit_total_exposure"] = step["result"].get("total_exposure")
            else:
                credit_unresolvable = True
                update["credit_checked"] = False
        elif step["action"] == "check_stock":
            stock_checked = True
            update["stock_checked"] = True
            update["stock_sufficient"] = step["succeeded"]
            update["stock_total"] = step["result"].get("stock_total")
        elif step["action"] == "create_order" and step["succeeded"]:
            update["sales_order_id"] = step["result"]["sales_order_id"]
            update["sales_order_status"] = step["result"]["status"]
            update["sales_order_total"] = step["result"]["total_amount"]

    # The human-in-the-loop gate (agreed with the user): create_order
    # never runs automatically (see plan_executor.GATE_BEFORE) — once
    # every real check it depends on has passed, this returns a real,
    # human-readable preview of exactly what WOULD be created, plus the
    # exact resolved context needed to actually create it, for a
    # separate, explicit approval call (app/routers/approvals.py) to
    # use. No order is written to the ERP until that call happens.
    if result["status"] == "AWAITING_APPROVAL":
        pending = result["pending_action"]

        # Only ever offered for the true zero-stock case (agreed with the
        # user): third_party_node sources the SHORTFALL from a vendor but
        # never reserves/ships an available-stock portion the way
        # hybrid_node does, so offering "use a vendor instead" on a
        # partial-stock order would silently lose the stock-covered
        # part. Also gated on can_produce/not configurable, since a
        # configurable product always goes CTO regardless, and a
        # not-producible product's own fulfillment decision already
        # considers vendors on its own.
        vendor_names: list[str] = []
        stock_total = update.get("stock_total")
        if (
            stock_checked
            and stock_total == 0
            and context.get("can_produce")
            and not context.get("product_configurable")
        ):
            vendors = erp.get_vendors_for_product(context.get("product_id"))
            vendor_names = [v["vendor_name"] for v in vendors]

        # Planning before approval (agreed with the user): fulfillment
        # strategy — and, for MTO/CTO/HYBRID, the real production plan;
        # for THIRD_PARTY/TRADING, the real vendor pick — is decided now,
        # not after approval, so the human approves the complete proposed
        # plan rather than an order blind to how it'll be fulfilled.
        # Nothing here is irreversible: MTS needs no plan at all, the
        # production plan's ProductionOrder is PLANNED (deleted on
        # reject) and its schedule is a non-committing what-if
        # simulation, and vendor sourcing is a pure decision with no
        # order created yet.
        fulfillment_preview = None
        production_plan = None
        vendor_plan = None
        if context.get("product_id") and context.get("quantity"):
            fulfillment_decision = await fulfillment_agent(
                product_name=context.get("product_name"),
                quantity=context.get("quantity"),
                stock_total=update.get("stock_total") or 0,
                can_produce=bool(context.get("can_produce")),
                product_configurable=bool(context.get("product_configurable")),
                lead_time_days=context.get("lead_time_days"),
            )
            split = compute_fulfillment_split(
                fulfillment_decision.strategy, context.get("quantity"), update.get("stock_total") or 0
            )
            fulfillment_preview = {
                "strategy": fulfillment_decision.strategy,
                "reasoning": fulfillment_decision.reasoning,
                "from_stock": split["from_stock"],
                "to_produce": split["to_produce"],
            }

            if fulfillment_decision.strategy in ("MTO", "CTO", "HYBRID") and split["to_produce"] > 0:
                configuration_notes = None
                if fulfillment_decision.strategy == "CTO":
                    configuration = await configuration_agent(
                        product_name=context.get("product_name"),
                        user_message=context.get("user_message") or "",
                    )
                    if configuration.options:
                        options_text = "; ".join(f"{o.attribute}: {o.value}" for o in configuration.options)
                        configuration_notes = f"Requested configuration: {options_text}. {configuration.notes}"
                    else:
                        configuration_notes = configuration.notes
                production_plan = await _plan_production_via_manufacturing_services(
                    product_id=context.get("product_id"),
                    product_name=context.get("product_name"),
                    quantity=split["to_produce"],
                    required_date=context.get("requested_deadline"),
                    configuration_notes=configuration_notes,
                )
                # Real gap found live (agreed with the user): "source from
                # vendor instead" used to be a blind choice — a vendor
                # NAME with no lead time or expected date to actually
                # compare against the production plan the human DOES get
                # to see. Computing the vendor plan here too, whenever the
                # override is genuinely available, means both options are
                # equally informed before the human picks either one —
                # not one fully-planned path and one leap of faith.
                if vendor_names:
                    vendor_plan = await _plan_vendor_sourcing(
                        context.get("product_id"), context.get("product_name"), split["to_produce"], context.get("lead_time_days")
                    )
            elif fulfillment_decision.strategy == "THIRD_PARTY" and split["to_produce"] > 0:
                vendor_plan = await _plan_vendor_sourcing(
                    context.get("product_id"), context.get("product_name"), split["to_produce"], context.get("lead_time_days")
                )

        update["pending_approval"] = {
            "action": pending["action"],
            "context": {
                **pending["context"],
                "fulfillment": fulfillment_preview,
                "production_plan": production_plan,
                "vendor_plan": vendor_plan,
            },
            "preview": {
                "customer_name": pending["context"].get("customer_name"),
                "product_name": pending["context"].get("product_name"),
                "quantity": pending["context"].get("quantity"),
                "unit_price": pending["context"].get("price"),
                "estimated_value": (
                    (pending["context"].get("quantity") or 0) * (pending["context"].get("price") or 0)
                ),
                "credit_within_limit": update.get("credit_within_limit"),
                "stock_sufficient": update.get("stock_sufficient") if stock_checked else None,
                "vendor_available": bool(vendor_names),
                "vendor_names": vendor_names,
                "fulfillment": fulfillment_preview,
                "production_plan": production_plan,
                "vendor_plan": vendor_plan,
            },
        }

    # Phase 4 (agreed with the user, scoped honestly): the one demonstrated
    # composed pattern's only real failure mode — a gated credit check —
    # has exactly one correct real-world response, the same one
    # credit_hold_node already gives a normal DIRECT_SALES order: stop and
    # flag for human review, not retry a different way. So this reuses
    # that existing status/semantics rather than a generic "PARTIAL",
    # instead of inventing adaptive LLM replanning with zero evidence any
    # composed pattern actually needs it yet.
    credit_failed = update.get("credit_checked") and not update.get("credit_within_limit")
    if credit_unresolvable and result["status"] == "PARTIAL":
        update["status"] = "CUSTOMER_NOT_FOUND"
    elif credit_failed and result["status"] == "PARTIAL":
        update["status"] = "ON_CREDIT_HOLD"

    parts = [f"{s['action']}: {'OK' if s['succeeded'] else 'did not pass'}" for s in result["executed"]]
    parts += [f"{s['action']}: skipped ({s['reason']})" for s in result["skipped"]]
    summary = "Composed plan (" + ", ".join(step["action"] for step in state["request_action_plan"]) + "): " + "; ".join(parts)

    if update["status"] == "CUSTOMER_NOT_FOUND":
        summary += (
            " We don't have this customer on file, so credit couldn't be checked and "
            "no order was created. A new customer needs to be set up in the ERP first."
        )
    elif update["status"] == "ON_CREDIT_HOLD":
        summary += (
            f" Total exposure {update.get('credit_total_exposure')} would exceed the "
            f"{context.get('customer_credit_limit')} limit — held on credit hold, "
            f"no order created until credit is released."
        )
    elif update["status"] == "AWAITING_APPROVAL":
        summary += " All checks passed — order prepared and awaiting your approval before it's created."

    update["response"] = summary
    return update


# Order-to-production Phase 1: dual-write the real, relational Customer/
# SalesOrder/OrderLine/FulfillmentPlan/FulfillmentLine rows alongside the
# mock-ERP SalesOrders-sheet row every existing channel page/read-path
# still depends on. Best-effort — a failure here logs and returns None,
# never raises, so the real (already-committed) mock-ERP order this is
# describing is never put at risk by this new, additive layer.
async def _dual_write_order_and_fulfillment(state: SalesState, context: dict) -> dict:
    try:
        customer_id = await order_domain.find_or_create_customer(state["customer_name"])
        due_date = context.get("requested_deadline") or compute_target_completion_date(state.get("lead_time_days"))
        quantity = state["quantity"]
        value = round((state.get("price") or 0) * quantity, 2)
        strategy = state["fulfillment_strategy"]

        real_sales_order_id = await order_domain.create_sales_order_record(
            customer_id=customer_id,
            due_date=due_date,
            value=value,
            priority=0,
            order_number=state["sales_order_id"],
            channel="domestic_sales",
            fulfillment_type=strategy,
            currency="INR",
            created_by="agent-orchestrator",
            external_order_id=state["sales_order_id"],
        )

        lines: list[dict] = []
        if state.get("fulfillment_from_stock", 0) > 0:
            lines.append({"sourceType": "STOCK", "quantity": state["fulfillment_from_stock"]})
        # Fulfillment architecture hardening (agreed with the user): TRADING
        # (arrives at our warehouse first) is BUY; THIRD_PARTY/drop-ship is
        # DROP_SHIP — real, distinct Oracle-style strategies (see
        # _plan_vendor_sourcing's strategy_label/drop_ship), no longer
        # collapsed into one generic VENDOR sourceType. Neither has a real
        # Postgres execution document (see the schema's own comment on
        # FulfillmentSourceType) — only a mock-ERP Trading Order, recorded
        # via executionReference once _execute_vendor_sourcing runs.
        if strategy in ("THIRD_PARTY", "TRADING") and state.get("fulfillment_to_produce", 0) > 0:
            vendor_plan = context.get("vendor_plan") or {}
            lines.append({
                "sourceType": "DROP_SHIP" if vendor_plan.get("drop_ship") else "BUY",
                "quantity": state["fulfillment_to_produce"],
                "vendorId": vendor_plan.get("vendor_id"),
                "vendorName": vendor_plan.get("vendor_name"),
            })
        elif state.get("fulfillment_to_produce", 0) > 0:
            lines.append({"sourceType": "PRODUCTION", "quantity": state["fulfillment_to_produce"]})

        plan = await order_domain.create_order_line_and_fulfillment(
            sales_order_id=real_sales_order_id,
            product_id=None,  # resolved by manufacturing product mapping, not this generic write
            product_name=state["product_name"],
            quantity=quantity,
            unit_price=state.get("price") or 0,
            requested_date=context.get("requested_deadline"),
            strategy=strategy,
            reasoning=state.get("fulfillment_reasoning"),
            lines=lines,
        )
        fulfillment_line_ids = {l["sourceType"]: l["id"] for l in plan["fulfillmentLines"]}
        return {"real_sales_order_id": real_sales_order_id, "fulfillment_line_ids": fulfillment_line_ids}
    except Exception:
        logger.warning("Order-to-production dual-write failed for %s — mock-ERP order is unaffected", state.get("sales_order_id"), exc_info=True)
        return {"real_sales_order_id": None, "fulfillment_line_ids": {}}


# Fulfillment architecture hardening (agreed with the user): the
# orchestration boundary between "what happened" (a branch's own return
# dict — mts_node's/_execute_vendor_sourcing's real result) and "the
# canonical fulfillment record" (order-service's FulfillmentLine). Both are
# best-effort/non-blocking, same principle as the dual-write itself — the
# real mock-ERP outcome these describe has already committed by the time
# either runs.
async def _patch_stock_execution(state: SalesState, branch_update: dict) -> None:
    stock_fulfillment_line_id = (state.get("fulfillment_line_ids") or {}).get("STOCK")
    if not stock_fulfillment_line_id:
        return
    try:
        if branch_update.get("reservation_id"):
            # PENDING -> ALLOCATED -> FULFILLED: order-service's own
            # transition table has no direct PENDING -> FULFILLED edge (see
            # FULFILLMENT_LINE_TRANSITIONS) — reservation succeeding really
            # is "allocated" before delivery/billing completes it, so this
            # is the real intermediate state, not a workaround.
            await order_domain.patch_fulfillment_line(stock_fulfillment_line_id, status="ALLOCATED")
            await order_domain.patch_fulfillment_line(
                stock_fulfillment_line_id,
                execution_reference=branch_update["reservation_id"],
                status="FULFILLED",
                # Order Orchestration (Phase 2): the real confirmed delivery
                # date _deliver_and_bill already computed — never invented here.
                promised_date=branch_update.get("confirmed_delivery_date"),
            )
        elif branch_update.get("status") == "FULFILLMENT_FAILED":
            await order_domain.patch_fulfillment_line(stock_fulfillment_line_id, status="FAILED")
    except Exception:
        logger.warning("Could not update STOCK FulfillmentLine %s", stock_fulfillment_line_id, exc_info=True)


async def _patch_vendor_execution(state: SalesState, branch_update: dict) -> None:
    vendor_line_id = (state.get("fulfillment_line_ids") or {}).get("BUY") or (state.get("fulfillment_line_ids") or {}).get("DROP_SHIP")
    if not vendor_line_id:
        return
    try:
        if branch_update.get("trading_order_id"):
            # PENDING -> EXECUTION_CREATED -> FULFILLED, same reasoning as
            # the STOCK leg above — the real Trading Order existing is the
            # execution-created milestone, not yet completion.
            await order_domain.patch_fulfillment_line(vendor_line_id, status="EXECUTION_CREATED")
            await order_domain.patch_fulfillment_line(
                vendor_line_id,
                execution_reference=branch_update["trading_order_id"],
                status="FULFILLED",
                promised_date=branch_update.get("expected_arrival"),
            )
        elif branch_update.get("status") == "FULFILLMENT_FAILED":
            await order_domain.patch_fulfillment_line(vendor_line_id, status="FAILED")
    except Exception:
        logger.warning("Could not update BUY/DROP_SHIP FulfillmentLine %s", vendor_line_id, exc_info=True)


# The other half of the gap this closes: an order approved through the
# composed-execution gate (app/routers/approvals.py) used to just sit at
# "Sales Order Created" — nothing ever picked it back up into fulfillment,
# unlike the normal DIRECT_SALES path, where fulfillment_decision_node
# always runs right after order creation. This reuses those exact same
# node functions (no duplicated fulfillment logic) against a state built
# from the approval's own echoed context, so an approved order goes
# through the real MTS/MTO/CTO/HYBRID/THIRD_PARTY decision and — for
# MTS/the stock leg of HYBRID — all the way to a real delivery + invoice,
# same as it would have from the chat-only path.
async def run_post_approval_fulfillment(context: dict, sales_order_id: str, prefer_vendor: bool = False) -> dict:
    state: SalesState = {
        "user_message": context.get("user_message") or "",
        "sales_order_id": sales_order_id,
        "customer_id": context.get("customer_id"),
        "customer_name": context.get("customer_name"),
        "product_id": context.get("product_id"),
        "product_name": context.get("product_name"),
        "quantity": context.get("quantity"),
        "price": context.get("price"),
        "can_produce": bool(context.get("can_produce")),
        "product_configurable": bool(context.get("product_configurable")),
        "lead_time_days": context.get("lead_time_days"),
        "stock": context.get("stock") or [],
        "response": f"Sales Order {sales_order_id} confirmed.",
    }

    stock_total = sum(s.get("stock_qty", 0) for s in state["stock"])

    # Human override: both options — produce in-house vs. source from a
    # vendor — are now planned pre-approval (see composed_execution_node),
    # so choosing "source from vendor" replays that same already-decided
    # plan rather than deciding fresh here. Only falls back to a live
    # decision if somehow nothing was pre-computed (defensive, not the
    # expected path — the frontend only offers this choice when a plan
    # was already shown).
    if prefer_vendor and stock_total == 0 and state["can_produce"] and not state["product_configurable"]:
        vendor_plan = context.get("vendor_plan") or await _plan_vendor_sourcing(
            state["product_id"], state["product_name"], state["quantity"], state["lead_time_days"]
        )
        if vendor_plan.get("vendors_available"):
            # A real bug found live: choosing "source from vendor instead"
            # bypasses the production plan entirely, but the draft PLANNED
            # order that plan already created (pre-approval, to show the
            # human what producing it would look like) was never cleaned
            # up — it just sat there orphaned, competing for machine
            # capacity in every future scheduling run. Same cleanup
            # principle as a straight REJECT.
            stale_production_order_id = (context.get("production_plan") or {}).get("production_order_id")
            if stale_production_order_id:
                try:
                    await mfg.delete_production_order(stale_production_order_id)
                except Exception:
                    pass

            state["fulfillment_from_stock"] = 0
            state["fulfillment_to_produce"] = state["quantity"]
            state["fulfillment_reasoning"] = (
                "Sourced from a vendor by explicit human choice, instead of producing it in-house."
            )
            branch_update = _execute_vendor_sourcing(state, vendor_plan)
            state.update(branch_update)
            # Remediation (agreed with the user): this early-return used to
            # bypass the dual-write entirely — a real Trading Order got
            # created (mock-ERP side) but no SalesOrder/OrderLine/
            # FulfillmentPlan/FulfillmentLine existed for it, unlike every
            # other real fulfillment path. Only reached once
            # _execute_vendor_sourcing has actually set fulfillment_strategy
            # (i.e. the trading order really was created) — a failed one
            # returns FULFILLMENT_FAILED with no strategy, nothing to record.
            if state.get("fulfillment_strategy"):
                dual_write_update = await _dual_write_order_and_fulfillment(state, {**context, "vendor_plan": vendor_plan})
                state.update(dual_write_update)
                await _patch_vendor_execution(state, branch_update)
            return state

    # Replay, not re-decision (agreed with the user): fulfillment strategy
    # and — for MTO/CTO/HYBRID/THIRD_PARTY — the production or vendor
    # plan were already decided pre-approval (composed_execution_node) and
    # echoed back verbatim in context, exactly the same principle
    # execute_gated_action already uses for create_order itself. No LLM
    # runs again on this path; a fresh decision here could disagree with
    # what the human actually approved.
    fulfillment = context.get("fulfillment")
    if fulfillment is None:
        # Defensive fallback only — every real approval created through
        # composed_execution_node populates this; a caller that somehow
        # didn't gets the old on-the-spot decision rather than crashing.
        decision_update = await fulfillment_decision_node(state)
        state.update(decision_update)
    else:
        state["fulfillment_strategy"] = fulfillment["strategy"]
        state["fulfillment_reasoning"] = fulfillment["reasoning"]
        state["fulfillment_from_stock"] = fulfillment["from_stock"]
        state["fulfillment_to_produce"] = fulfillment["to_produce"]
        state["response"] += (
            f" Fulfillment: {fulfillment['strategy']} "
            f"({fulfillment['from_stock']} from stock, {fulfillment['to_produce']} to produce). "
            f"{fulfillment['reasoning']}"
        )

    dual_write_update = await _dual_write_order_and_fulfillment(state, context)
    state.update(dual_write_update)

    strategy = state["fulfillment_strategy"]
    if strategy == "MTS":
        branch_update = await mts_node(state)
        await _patch_stock_execution(state, branch_update)
    elif strategy in ("MTO", "CTO", "HYBRID") and state["fulfillment_to_produce"] > 0:
        production_plan = context.get("production_plan")
        if strategy == "HYBRID" and state["fulfillment_from_stock"] > 0:
            branch_update = await _execute_hybrid_with_plan(state, production_plan)
        else:
            branch_update = await _execute_production_plan(state, production_plan)
    elif strategy == "THIRD_PARTY":
        vendor_plan = context.get("vendor_plan")
        if vendor_plan and vendor_plan.get("vendors_available"):
            branch_update = _execute_vendor_sourcing(state, vendor_plan)
            await _patch_vendor_execution(state, branch_update)
        else:
            branch_update = await unfulfillable_node(state)
    else:
        branch_update = await unfulfillable_node(state)
    state.update(branch_update)
    return state


async def process_node(state: SalesState):
    # Phase 2.5 (agreed with the user): the one place the richer
    # understanding actually influences a real decision instead of just
    # riding along in state — resolved_references gives process_agent
    # corroborating evidence about existing records the request refers
    # to. Everything else about this call is unchanged from before Phase
    # 2, and an empty/all-unresolved reference list changes nothing (see
    # process_agent's own prompt), so a request with no references at all
    # decides exactly as it always did.
    result = await process_agent(
        intent=state["intent"],
        customer=state["customer"],
        product=state["product"],
        quantity=state["quantity"],
        requested_deadline=state["requested_deadline"],
        customer_exists=state["customer_exists"],
        customer_active=state["customer_active"],
        product_valid=state["product_valid"],
        resolved_references=state.get("resolved_references"),
    )

    return {
        "entry_type": result.entry_type,
        "process": result.process,
        "starting_stage": result.starting_stage,
        "process_reasoning": result.reasoning,
    }


# Deterministic conditional edge (PLAN.md: Routers are plain LangGraph
# conditional nodes, never LLM calls). Branches on the Process Decision
# Agent's entry_type — not itself a decision, just a dispatch.
#
# One narrow override before that dispatch: process_agent's own system
# prompt forces FINANCIAL whenever product_valid is false, which is right
# for a genuine standalone adjustment but wrong for "order 30 pumps" where
# the product just isn't in our catalog — that's the exact bug this
# session found live. request_understanding_agent's two booleans are an
# independent second opinion process_agent never sees change process_agent
# itself: this catches only the case where the request plainly describes
# wanting a product/service AND contains no financial-adjustment language
# at all, so process_agent's classification is essentially guaranteed
# wrong rather than merely uncertain.
def entry_router(state: SalesState) -> str:
    if (
        state["entry_type"] == "FINANCIAL"
        and state.get("mentions_product_or_service")
        and not state.get("mentions_financial_adjustment")
    ):
        return "unclear"
    if state["entry_type"] == "PRE_SALES":
        return "pre_sales"
    if state["entry_type"] == "DIRECT_SALES":
        return "direct_sales"
    if state["entry_type"] == "POST_SALES":
        return "post_sales"
    if state["entry_type"] == "SERVICE":
        return "service"
    if state["entry_type"] == "SUBSCRIPTION":
        return "subscription"
    if state["entry_type"] == "PROJECT":
        return "project"
    if state["entry_type"] == "EXPORT":
        return "export"
    if state["entry_type"] == "CONSIGNMENT":
        return "consignment"
    if state["entry_type"] == "FINANCIAL":
        return "financial"
    return "not_implemented"


# Post-Sales workflow. Reached directly from entry_router, not through
# Direct Sales — there's no state["response"] to build on yet here.
async def post_sales_node(state: SalesState):
    decision = await post_sales_agent(
        process=state["process"],
        user_message=state["user_message"],
    )

    result = process_post_sales_action(
        action=decision.action,
        referenced_order_id=decision.referenced_order_id,
        customer_id=state["customer_id"],
        customer_name=state["customer_name"],
        product_id=state["product_id"],
        product_name=state["product_name"],
        quantity=state["quantity"],
        unit_price=state["price"],
        reason=decision.reason,
    )

    if not result["created"]:
        return {
            "status": "REJECTED",
            "response": result["reason"],
        }

    id_field = {}
    if decision.action == "RETURN":
        id_field["return_id"] = result["post_sales_id"]
    elif decision.action == "CREDIT_MEMO":
        id_field["credit_memo_id"] = result["post_sales_id"]
    else:
        id_field["debit_memo_id"] = result["post_sales_id"]

    amount_text = f", amount {result['amount']}" if result["amount"] is not None else ""
    order_text = f" (order {decision.referenced_order_id})" if decision.referenced_order_id else ""

    return {
        **id_field,
        # A RETURN isn't done yet — it's PENDING_INSPECTION until the
        # goods are actually inspected. CREDIT_MEMO/DEBIT_MEMO are
        # financial-only and stay immediate, so they're really COMPLETED.
        "status": result["status"] if decision.action == "RETURN" else "COMPLETED",
        "response": (
            f"{decision.action} {result['post_sales_id']}{order_text}: "
            f"status {result['status']} for {state['quantity']} x "
            f"{state['product_name']}{amount_text}. {decision.reason}"
        ),
    }


# Service workflow. Reached directly from entry_router, same shape as
# Post-Sales — no product/quantity/price the way Direct Sales has, since
# this is scoped work, not a catalog item. No milestone/execution/billing
# progression yet (see service_tools.py) — this records the request as a
# real, honest REQUESTED order, not a faked completed engagement.
async def service_node(state: SalesState):
    decision = await service_agent(state["user_message"])

    result = create_service_order(
        customer_id=state["customer_id"],
        customer_name=state["customer_name"],
        service_type=decision.service_type,
        scope_description=decision.scope_description,
        estimated_hours=decision.estimated_hours,
    )

    if not result["created"]:
        return {
            "status": "REJECTED",
            "response": result["reason"],
        }

    if result["estimated_amount"] is not None:
        pricing_note = f" Estimated amount: {result['estimated_amount']} ({result['rate_type']} rate)."
    elif result["rate_type"] is not None:
        pricing_note = f" Rate on file is {result['rate']}/hr but no hours were estimated yet."
    else:
        pricing_note = " No rate on file for this service type — pricing to be determined manually."

    return {
        "service_order_id": result["service_order_id"],
        "status": result["status"],
        "response": (
            f"Service Order {result['service_order_id']} ({decision.service_type}) "
            f"requested: {decision.scope_description}. Status: {result['status']}."
            f"{pricing_note}"
        ),
    }


# Subscription workflow. Reached directly from entry_router. Plan
# resolution is deterministic (find_subscription_plan) against a real
# seeded catalog — the agent only interprets what the customer said, same
# separation as every other agent in this pipeline.
#
# NEW always creates a fresh subscription. RENEWAL/CANCEL act on the
# customer's existing ACTIVE subscription for that plan — they never
# create a duplicate row, and they fail honestly (REJECTED) if there's no
# real subscription to act on, rather than fabricating one.
async def subscription_node(state: SalesState):
    decision = await subscription_agent(state["user_message"])

    plan = find_subscription_plan(decision.requested_plan_name)
    if plan is None:
        return {
            "status": "REJECTED",
            "response": (
                f"No subscription plan on file matching "
                f"'{decision.requested_plan_name}'."
            ),
        }

    if decision.action == "NEW":
        result = create_subscription(
            customer_id=state["customer_id"],
            customer_name=state["customer_name"],
            plan_id=plan["plan_id"],
            plan_name=plan["plan_name"],
            price=plan["price"],
            billing_frequency=plan["billing_frequency"],
            action="NEW",
        )
        return {
            "subscription_id": result["subscription_id"],
            "status": result["status"],
            "response": (
                f"Subscription {result['subscription_id']} (NEW): "
                f"{plan['plan_name']} at {plan['price']}/{plan['billing_frequency']}, "
                f"renews {result['renewal_date']}. Status: {result['status']}."
            ),
        }

    existing = find_active_subscription(state["customer_id"], plan["plan_id"])
    if existing is None:
        return {
            "status": "REJECTED",
            "response": (
                f"No active subscription found for {plan['plan_name']} to "
                f"{decision.action.lower()}."
            ),
        }

    if decision.action == "RENEWAL":
        result = renew_subscription(existing["subscription_id"])
        if not result["renewed"]:
            return {"status": "REJECTED", "response": result["reason"]}
        return {
            "subscription_id": result["subscription_id"],
            "status": result["status"],
            "response": (
                f"Subscription {result['subscription_id']} (RENEWAL): {plan['plan_name']} "
                f"renewed, now renews {result['renewal_date']}. Status: {result['status']}."
            ),
        }

    # CANCEL
    result = cancel_subscription(existing["subscription_id"])
    if not result["cancelled"]:
        return {"status": "REJECTED", "response": result["reason"]}
    return {
        "subscription_id": result["subscription_id"],
        "status": result["status"],
        "response": (
            f"Subscription {result['subscription_id']} (CANCEL): {plan['plan_name']} "
            f"cancelled. Status: {result['status']}."
        ),
    }


# Project workflow. Reached directly from entry_router, same shape as
# Service/Subscription. Material assessment and production creation reuse
# the exact same _assess_materials()/_procure_shortages() helpers MTO/CTO
# already use (defined further below in this module) — a Project doesn't
# get its own copy of that logic, per the roadmap's own instruction not to
# duplicate what Fulfillment already does. A project with no resolved
# product/quantity (a pure-engineering/consulting engagement) still gets
# created with real milestones — it just skips production entirely rather
# than faking one, same honest-gap pattern as THIRD_PARTY with no vendor.
async def project_node(state: SalesState):
    decision = await project_agent(state["user_message"])

    result = create_project(
        customer_id=state["customer_id"],
        customer_name=state["customer_name"],
        product_id=state.get("product_id"),
        product_name=state.get("product_name"),
        quantity=state.get("quantity"),
        project_type=decision.project_type,
        scope_description=decision.scope_description,
        contract_value=decision.contract_value,
    )

    if not result["created"]:
        return {
            "status": "REJECTED",
            "response": result["reason"],
        }

    milestone_text = "; ".join(
        f"{m['milestone_name']} {m['milestone_id']}"
        + (f" ({m['amount']})" if m["amount"] is not None else " (amount TBD — no contract value stated)")
        for m in result["milestones"]
    )
    response = (
        f"Project {result['project_id']} ({decision.project_type}) awarded: "
        f"{decision.scope_description}. Milestones: {milestone_text}."
    )

    production_note = ""
    quantity = state.get("quantity")
    product_id = state.get("product_id")
    if product_id and quantity:
        assessment = _assess_materials(product_id, quantity)
        has_shortage = bool(assessment["shortages"])
        production = erp.create_production_order(
            sales_order_id=None,
            product_id=product_id,
            product_name=state.get("product_name"),
            quantity=quantity,
            lead_time_days=state.get("lead_time_days"),
            initial_status="AWAITING_MATERIALS" if has_shortage else "PLANNED",
        )
        if production["created"]:
            attach_production_order(result["project_id"], production["production_order_id"])
            procurement_note = await _procure_shortages(
                assessment, production["production_order_id"], production["target_completion_date"]
            )
            production_note = (
                f" Production Order {production['production_order_id']} created "
                f"({production['status']}), target completion {production['target_completion_date']}."
            ) + procurement_note
        else:
            production_note = f" Production order failed: {production['reason']}"

    return {
        "project_id": result["project_id"],
        "status": "IN_EXECUTION",
        "response": response + production_note,
    }


# Export workflow. Reached directly from entry_router. Only creates the
# order and its proforma invoice here — matches the Trading precedent
# exactly: everything physically/operationally downstream (payment
# verification, stock-vs-production allocation, documentation, freight,
# shipment, invoicing, closing) happens through direct tool/operational
# calls in export_tools.py (or allocate_or_produce_export_order() below),
# not further chat messages. A real export starts with a confirmed order
# and a proforma invoice — everything after that is triggered by real
# events (a bank confirming an LC, a warehouse booking freight), not a
# customer typing another sentence.
async def export_node(state: SalesState):
    decision = await export_agent(state["user_message"])

    result = create_export_order(
        customer_id=state["customer_id"],
        customer_name=state["customer_name"],
        product_id=state.get("product_id"),
        product_name=state.get("product_name"),
        quantity=state.get("quantity"),
        unit_price=state.get("price"),
        destination_country=decision.destination_country,
        incoterm=decision.incoterm,
    )

    if not result["created"]:
        return {
            "status": "REJECTED",
            "response": result["reason"],
        }

    return {
        "export_order_id": result["export_order_id"],
        "status": "CONFIRMED",
        "response": (
            f"Export Order {result['export_order_id']} confirmed for "
            f"{state.get('quantity')} x {state.get('product_name')} to "
            f"{decision.destination_country}"
            + (f" ({decision.incoterm})" if decision.incoterm else "")
            + f". Proforma invoice {result['proforma_invoice_id']} issued for {result['total_value']}. "
            f"Awaiting payment/LC verification before fulfillment proceeds."
        ),
    }


# The stock-vs-production allocation decision for a PAYMENT_VERIFIED
# export order — an operational trigger, not part of the chat graph (same
# reasoning as dispatch_trading_order). Reuses the exact same
# _assess_materials()/_procure_shortages() helpers MTO/CTO/Project already
# use, and erp.reserve_stock() when real stock covers the full quantity —
# no separate copy of that decision logic for Export.
async def allocate_or_produce_export_order(export_order_id: str) -> dict:
    order = find_export_order(export_order_id)
    if order is None:
        return {"allocated": False, "reason": f"No export order found with id {export_order_id}"}
    if order["status"] != "PAYMENT_VERIFIED":
        return {
            "allocated": False,
            "reason": f"{export_order_id} must be PAYMENT_VERIFIED before allocation (status: {order['status']}).",
        }

    stock_total = sum(row["stock_qty"] for row in erp.get_stock(order["product_id"]))

    if stock_total >= order["quantity"]:
        reservation = erp.reserve_stock(
            sales_order_id=None,
            product_id=order["product_id"],
            product_name=order["product_name"],
            quantity=order["quantity"],
        )
        if not reservation["reserved"]:
            return {"allocated": False, "reason": reservation["reason"]}
        set_export_fulfillment(
            export_order_id, fulfillment_source="STOCK", new_status="ALLOCATED",
            reservation_id=reservation["reservation_id"],
        )
        return {"allocated": True, "export_order_id": export_order_id, "status": "ALLOCATED"}

    assessment = _assess_materials(order["product_id"], order["quantity"])
    has_shortage = bool(assessment["shortages"])
    production = erp.create_production_order(
        sales_order_id=None,
        product_id=order["product_id"],
        product_name=order["product_name"],
        quantity=order["quantity"],
        lead_time_days=None,
        initial_status="AWAITING_MATERIALS" if has_shortage else "PLANNED",
    )
    if not production["created"]:
        return {"allocated": False, "reason": production["reason"]}

    procurement_note = await _procure_shortages(
        assessment, production["production_order_id"], production["target_completion_date"]
    )
    set_export_fulfillment(
        export_order_id, fulfillment_source="PRODUCTION", new_status="IN_PRODUCTION",
        production_order_id=production["production_order_id"],
    )
    return {
        "allocated": True,
        "export_order_id": export_order_id,
        "status": "IN_PRODUCTION",
        "note": procurement_note,
    }


# Consignment workflow. Reached directly from entry_router. Only the
# stock transfer happens here — same "chat graph handles the initial
# commitment, everything physical/operational after that is a direct
# tool call" split as Trading/Export. Sale reporting, unsold returns, and
# closing are all real operational events (a consignee reporting what
# they actually sold), not further chat messages, so they live as
# directly-callable functions in consignment_tools.py, not graph nodes.
async def consignment_node(state: SalesState):
    decision = await consignment_agent(state["user_message"])

    result = create_consignment(
        customer_id=state["customer_id"],
        customer_name=state["customer_name"],
        product_id=state.get("product_id"),
        product_name=state.get("product_name"),
        quantity_sent=state.get("quantity"),
        unit_price=state.get("price"),
        notes=decision.notes,
    )

    if not result["created"]:
        return {
            "status": "REJECTED",
            "response": result["reason"],
        }

    return {
        "consignment_id": result["consignment_id"],
        "status": "ACTIVE",
        "response": (
            f"Consignment {result['consignment_id']} created: "
            f"{result['quantity_sent']} x {state.get('product_name')} transferred to "
            f"{state['customer_name']}, no invoice issued yet. {decision.notes} "
            f"Billing happens only as sell-through is reported."
        ),
    }


# Financial workflow. Reached directly from entry_router — a standalone
# account adjustment, not tied to any order/product (that case is
# Post-Sales). The agent only extracts type/reference/reason; the amount
# is either what the customer actually stated or the request is rejected
# outright — never invented, never guessed downstream either. Below the
# approval threshold, this posts immediately in the same turn (nothing
# further needs a human); at/above it, resolve_financial_approval() and
# post_financial_adjustment() are real operational triggers a human calls
# later, same split as every other workflow's post-creation lifecycle.
async def financial_node(state: SalesState):
    try:
        decision = await financial_agent(state["user_message"])
    except BadRequestError as err:
        # financial_agent's own retry wrapper already exhausted 5 attempts
        # on this specific, narrow flake (see challenge.md) — reaching
        # here means the model consistently would not call the extraction
        # tool, which in practice happens when the request plainly isn't
        # a financial adjustment (entry_router only sends it here when
        # product_valid is false, so a request like "order 30 pumps" can
        # land here despite not being about money at all, and the model
        # correctly balks). That's a real "this doesn't fit" outcome, not
        # a crash — same graceful-rejection shape as a missing amount.
        if "tool_use_failed" not in str(err) and "output_parse_failed" not in str(err):
            raise
        return {
            "status": "REJECTED",
            "response": (
                "Could not process this as a financial adjustment — the request doesn't "
                "look like a standalone account adjustment (no product/order was recognized, "
                "but this also isn't a credit/debit memo request)."
            ),
        }

    result = create_financial_adjustment(
        adjustment_type=decision.adjustment_type,
        customer_id=state["customer_id"],
        customer_name=state["customer_name"],
        reference=decision.reference,
        amount=decision.amount,
        reason=decision.reason,
    )

    if not result["created"]:
        return {
            "status": "REJECTED",
            "response": result["reason"],
        }

    financial_adjustment_id = result["financial_adjustment_id"]

    if result["approval_required"]:
        return {
            "financial_adjustment_id": financial_adjustment_id,
            "status": "PENDING_APPROVAL",
            "response": (
                f"Financial Adjustment {financial_adjustment_id} ({decision.adjustment_type}) "
                f"for {decision.amount}: {decision.reason} Requires approval before posting "
                f"(at/above the {FINANCIAL_APPROVAL_THRESHOLD} threshold)."
            ),
        }

    post_financial_adjustment(financial_adjustment_id)
    return {
        "financial_adjustment_id": financial_adjustment_id,
        "status": "POSTED",
        "response": (
            f"Financial Adjustment {financial_adjustment_id} ({decision.adjustment_type}) "
            f"for {decision.amount} posted: {decision.reason}"
        ),
    }


# Pre-Sales workflow (build-order step 6). Only QUOTE_REQUEST is reachable
# today (the only intent that lands on PRE_SALES) — Lead/Inquiry stages have
# no dedicated agent yet since nothing currently produces them.
async def pre_sales_node(state: SalesState):
    stock_total = sum(s["stock_qty"] for s in state.get("stock", []))
    result = await quotation_agent(
        customer_name=state["customer_name"],
        product_name=state["product_name"],
        quantity=state["quantity"],
        price=state["price"],
        stock_total=stock_total,
        can_produce=state["can_produce"],
        lead_time_days=state["lead_time_days"],
    )

    # Deterministic tool call — the agent decided what to quote, the tool
    # is what actually records the transaction.
    created = create_quotation(
        customer_id=state["customer_id"],
        customer_name=state["customer_name"],
        product_id=state["product_id"],
        product_name=state["product_name"],
        quantity=result.quantity,
        quoted_price=result.quoted_price,
        valid_for_days=result.valid_for_days,
        notes=result.notes,
    )

    if created["created"]:
        response = (
            f"Quotation {created['quotation_id']} for {result.quantity} x "
            f"{state['product_name']}: {result.quoted_price} each, total "
            f"{created['total_amount']}, valid until {created['valid_until']}. "
            f"{result.notes}"
        )
    else:
        response = created["reason"]

    return {
        "quoted_price": result.quoted_price,
        "quotation_total": result.total_amount,
        "quotation_valid_days": result.valid_for_days,
        "quotation_notes": result.notes,
        "quotation_id": created.get("quotation_id"),
        "quotation_status": created.get("status") if created["created"] else "NOT_CREATED",
        "status": "COMPLETED" if created["created"] else "REJECTED",
        "response": response,
    }


# Direct Sales workflow (build-order step 7). No LLM judgment needed for
# order creation itself — price is the catalog price (no negotiation on a
# direct order) and every input is already resolved by Context; creating
# the order is purely deterministic validation + a tool call, same
# principle as approvals.
async def direct_sales_node(state: SalesState):
    created = erp.create_sales_order(
        customer_id=state["customer_id"],
        customer_name=state["customer_name"],
        customer_active=state["customer_active"],
        product_id=state["product_id"],
        product_name=state["product_name"],
        quantity=state["quantity"],
        unit_price=state["price"],
        requested_deadline=state["requested_deadline"],
    )

    if not created["created"]:
        return {
            "sales_order_id": None,
            "sales_order_status": "NOT_CREATED",
            "status": "REJECTED",
            "response": created["reason"],
        }

    return {
        "sales_order_id": created["sales_order_id"],
        "sales_order_status": created["status"],
        "sales_order_total": created["total_amount"],
        "status": "COMPLETED",
        "response": (
            f"Sales Order {created['sales_order_id']} for {state['quantity']} x "
            f"{state['product_name']}: total {created['total_amount']}, "
            f"status {created['status']}."
        ),
    }


# Only reached for a confirmed Sales Order — a rejected one ends the graph
# before this.
def direct_sales_router(state: SalesState) -> str:
    if state["status"] == "REJECTED":
        return "end"
    return "credit_check"


# Deterministic — no LLM. Existing exposure comes from real SalesOrders
# already on record for this customer; if the check can't run at all
# (missing customer/credit_limit — shouldn't happen given the guard
# already passed in create_sales_order, but defensive), fail open rather
# than block on a check with no data.
async def credit_check_node(state: SalesState):
    result = erp.check_credit(
        customer_id=state["customer_id"],
        credit_limit=state["customer_credit_limit"],
        new_order_amount=state["sales_order_total"],
        exclude_sales_order_id=state["sales_order_id"],
    )

    if not result["checked"]:
        return {
            "credit_checked": False,
            "credit_within_limit": True,
            "response": state["response"] + f" Credit check skipped: {result['reason']}",
        }

    return {
        "credit_checked": True,
        "credit_within_limit": result["within_credit"],
        "credit_existing_exposure": result["existing_exposure"],
        "credit_total_exposure": result["total_exposure"],
        "response": state["response"] + (
            f" Credit check: total exposure {result['total_exposure']} against "
            f"a {result['credit_limit']} limit — "
            + ("within limit." if result["within_credit"] else "OVER LIMIT.")
        ),
    }


# Deterministic conditional edge, same pattern as entry_router/fulfillment_router.
def credit_router(state: SalesState) -> str:
    if not state["credit_within_limit"]:
        return "credit_hold"
    return "fulfillment_decision"


async def credit_hold_node(state: SalesState):
    update_sales_order_status(state["sales_order_id"], "CREDIT_BLOCKED")
    return {
        "sales_order_status": "CREDIT_BLOCKED",
        "status": "ON_CREDIT_HOLD",
        "response": state["response"] + (
            " Order held on credit hold — fulfillment does not proceed "
            "until credit is released."
        ),
    }


async def fulfillment_decision_node(state: SalesState):
    stock_total = sum(s["stock_qty"] for s in state.get("stock", []))
    decision = await fulfillment_agent(
        product_name=state["product_name"],
        quantity=state["quantity"],
        stock_total=stock_total,
        can_produce=state["can_produce"],
        product_configurable=state["product_configurable"],
        lead_time_days=state["lead_time_days"],
    )
    split = compute_fulfillment_split(decision.strategy, state["quantity"], stock_total)

    return {
        "fulfillment_strategy": decision.strategy,
        "fulfillment_reasoning": decision.reasoning,
        "fulfillment_from_stock": split["from_stock"],
        "fulfillment_to_produce": split["to_produce"],
        "response": (
            state["response"] + f" Fulfillment: {decision.strategy} "
            f"({split['from_stock']} from stock, {split['to_produce']} to produce). "
            f"{decision.reasoning}"
        ),
    }


# Deterministic conditional edge, same pattern as entry_router — branches
# on the Fulfillment Decision Agent's strategy, not itself a decision.
def fulfillment_router(state: SalesState) -> str:
    strategy = state["fulfillment_strategy"]
    if strategy == "MTS":
        return "mts"
    if strategy == "MTO":
        return "mto"
    if strategy == "CTO":
        return "cto"
    if strategy == "HYBRID":
        return "hybrid"
    if strategy == "THIRD_PARTY":
        return "third_party"
    # INTERCOMPANY — no other-plant/other-company data exists in this
    # system at all, so there is no tool that can act on this yet.
    return "unfulfillable"


# Shared by MTS (full quantity) and HYBRID (its stock leg only) — the
# Billing Agent decides terms/notes, erp.create_invoice() computes the amount
# deterministically. Only ever called for a quantity that's really been
# delivered — MTO/CTO's produced quantity never reaches this.
async def _deliver_and_bill(state: SalesState, quantity: int) -> dict:
    delivery = erp.create_delivery(
        sales_order_id=state["sales_order_id"],
        customer_id=state["customer_id"],
        customer_name=state["customer_name"],
        product_id=state["product_id"],
        product_name=state["product_name"],
        quantity=quantity,
        requested_delivery_date=state.get("requested_deadline"),
    )
    if not delivery["created"]:
        return {
            "delivery_id": None,
            "delivery_status": "NOT_CREATED",
            "confirmed_delivery_date": None,
            "invoice_id": None,
            "invoice_status": "NOT_CREATED",
            "invoice_amount": None,
            "note": f" Delivery failed: {delivery['reason']}",
        }

    decision = await billing_agent(
        quantity_delivered=quantity,
        quantity_ordered=state["quantity"],
        unit_price=state["price"],
    )
    invoice = erp.create_invoice(
        sales_order_id=state["sales_order_id"],
        delivery_id=delivery["delivery_id"],
        customer_id=state["customer_id"],
        customer_name=state["customer_name"],
        quantity_billed=quantity,
        unit_price=state["price"],
        payment_terms_days=decision.payment_terms_days,
        notes=decision.notes,
    )

    if not invoice["created"]:
        return {
            "delivery_id": delivery["delivery_id"],
            "delivery_status": delivery["status"],
            "confirmed_delivery_date": delivery["confirmed_delivery_date"],
            "invoice_id": None,
            "invoice_status": "NOT_CREATED",
            "invoice_amount": None,
            "note": (
                f" Delivered {quantity} units (delivery {delivery['delivery_id']}, "
                f"confirmed for {delivery['confirmed_delivery_date']}), "
                f"but invoicing failed: {invoice['reason']}"
            ),
        }

    return {
        "delivery_id": delivery["delivery_id"],
        "delivery_status": delivery["status"],
        "confirmed_delivery_date": delivery["confirmed_delivery_date"],
        "invoice_id": invoice["invoice_id"],
        "invoice_status": invoice["status"],
        "invoice_amount": invoice["invoice_amount"],
        "note": (
            f" Scheduled delivery {delivery['delivery_id']} for {delivery['confirmed_delivery_date']} "
            f"({quantity} units); invoiced {invoice['invoice_id']} for {invoice['invoice_amount']}, "
            f"due {invoice['due_date']}. {decision.notes}"
        ),
    }


async def mts_node(state: SalesState):
    result = erp.reserve_stock(
        sales_order_id=state["sales_order_id"],
        product_id=state["product_id"],
        product_name=state["product_name"],
        quantity=state["fulfillment_from_stock"],
    )
    if not result["reserved"]:
        return {
            "status": "FULFILLMENT_FAILED",
            "response": state["response"] + f" Stock reservation failed: {result['reason']}",
        }

    billing_update = await _deliver_and_bill(state, state["fulfillment_from_stock"])
    return {
        "delivery_id": billing_update["delivery_id"],
        "delivery_status": billing_update["delivery_status"],
        "confirmed_delivery_date": billing_update["confirmed_delivery_date"],
        "invoice_id": billing_update["invoice_id"],
        "invoice_status": billing_update["invoice_status"],
        "invoice_amount": billing_update["invoice_amount"],
        "status": "BILLED" if billing_update["invoice_id"] else "FULFILLED",
        # Fulfillment architecture hardening: the real execution reference
        # (STOCK has no Postgres FK either) for the caller to patch onto
        # the STOCK FulfillmentLine.
        "reservation_id": result["reservation_id"],
        "response": state["response"] + (
            f" Reserved from stock: {result['allocations']} "
            f"(reservation {result['reservation_id']})."
        ) + billing_update["note"],
    }


# Called BEFORE the production order is created — production planning
# should know whether materials are available before releasing an order,
# not find out afterward. Only acts when a real BOM exists (most products
# have none — that's a legitimately empty result, not a skipped check).
def _assess_materials(product_id: str, quantity: int) -> dict:
    availability = erp.check_material_availability(product_id, quantity)
    if not availability["has_bom"]:
        return {"has_bom": False, "shortages": []}
    shortages = [c for c in availability["components"] if c["shortage"] > 0]
    return {"has_bom": True, "shortages": shortages}


# Called AFTER the production order exists, so purchase orders can
# reference a real production_order_id — but the shortage itself was
# already known and baked into the order's initial status before this runs.
async def _procure_shortages(assessment: dict, production_order_id: str, target_completion_date: str) -> str:
    if not assessment["has_bom"]:
        return ""
    shortages = assessment["shortages"]
    if not shortages:
        return " All required materials are in stock."

    shortage_inputs = [
        {**s, "vendors": erp.get_vendors_for_component(s["component_id"])}
        for s in shortages
    ]
    decision = await procurement_agent(shortages=shortage_inputs, target_completion_date=target_completion_date)

    notes = []
    for choice in decision.choices:
        shortage = next((s for s in shortages if s["component_id"] == choice.component_id), None)
        vendor = next(
            (v for v in erp.get_vendors_for_component(choice.component_id) if v["vendor_id"] == choice.vendor_id),
            None,
        )
        if shortage is None or vendor is None:
            continue
        po = erp.create_purchase_order(
            production_order_id=production_order_id,
            component_id=choice.component_id,
            component_name=shortage["component_name"],
            vendor_id=vendor["vendor_id"],
            vendor_name=vendor["vendor_name"],
            quantity=shortage["shortage"],
            unit_cost=vendor["unit_cost"],
            lead_time_days=vendor["lead_time_days"],
        )
        if po["created"]:
            notes.append(
                f"{po['purchase_order_id']}: {shortage['shortage']} x "
                f"{shortage['component_name']} from {vendor['vendor_name']}, "
                f"arriving {po['expected_arrival']}"
            )

    if notes:
        return " Procurement: " + "; ".join(notes) + ". " + decision.notes
    return " Material shortage detected but procurement could not be placed."


# ============================================================
# Composed-execution (gated/approved) path only: production planning that
# actually orchestrates the real TS manufacturing services (order-service,
# routing-service, machine-service, inventory-service, scheduling-service)
# via app/integrations/manufacturing_services.py, instead of the mock-ERP-
# only BOM check above. mto_node/cto_node/hybrid_node/third_party_node
# below this block are the DIRECT_SALES (ungated) path's existing
# implementation and are deliberately untouched — this is a second,
# parallel implementation for the gated path only, not a replacement.
#
# Planning before approval, execution after approval: everything in
# "planning" is either read-only or a reversible PLANNED-status write
# (deleted on reject); everything in "execution" is the real, irreversible
# commit, and only ever runs after a human has approved.
# ============================================================

# No service in this repo owns Plant CRUD (confirmed by grep across every
# services/*/src) — Plant is tenant/infra setup, seeded once via
# packages/domain/prisma/seed.ts, not business data any service creates.
# Single-plant assumption for this demo scope, same category of
# tenant-specific config as the existing SAP_SALES_ORGANIZATION etc. above.
MANUFACTURING_PLANT_ID = os.environ.get("MANUFACTURING_PLANT_ID", "cmttuotng0000xucaila9ze65")


async def _plan_production_via_manufacturing_services(
    product_id: str,
    product_name: str | None,
    quantity: int,
    required_date: str | None,
    configuration_notes: str | None = None,
) -> dict:
    from app.config import MANUFACTURING_PRODUCT_IDS

    manufacturing_product_id = MANUFACTURING_PRODUCT_IDS.get(product_name or "")
    if manufacturing_product_id is None:
        # Phase 2 (agreed with the user): renamed from "UNPLANNABLE" —
        # this is Cause 1, a genuine configuration/master-data gap (no
        # product mapping at all), not Cause 2 (a real schedulable product
        # that just has no open capacity right now). The two were
        # previously collapsed into one word; a human reading this needs
        # to know "someone needs to fix master data" is a completely
        # different action from "wait for a slot." No scheduling call has
        # even been attempted yet at this point, so lookahead correctly
        # never runs for this cause.
        return {
            "verdict": "PLANNING_CONFIGURATION_ISSUE",
            "explanation": (
                f"No manufacturing master data is mapped for {product_name or product_id} — "
                "production cannot be planned."
            ),
            "materials": [],
            "routing_operations": [],
            "simulated_operations": [],
            "production_order_id": None,
            "plant_id": MANUFACTURING_PLANT_ID,
            "configuration_notes": configuration_notes,
            "procurement_plan": [],
        }

    # The real relocation (agreed with the user): everything that used to
    # happen right here — BOM/routing lookup, material availability,
    # draft order creation, the real what-if scheduling call, machine
    # name resolution, deterministic shortage detection, vendor pick —
    # now happens on APS Platform, a genuinely separate application.
    # request_production_plan is a real, synchronous HTTP call to it;
    # this still runs entirely before the human approval gate, so
    # "nothing commits before approval" is untouched.
    plan = await mfg.request_production_plan(
        manufacturing_product_id, product_name, quantity, required_date, configuration_notes
    )
    # apsAgent.ts's own "no BOM/routing exists at all" early-return still
    # uses this literal (Cause 1, the same real config gap as above, just
    # discovered one call later — see apsAgent.ts:planProduction) — renamed
    # to match, on the TS side as well as here.
    if plan.get("verdict") == "PLANNING_CONFIGURATION_ISSUE":
        return plan

    materials = plan["materials"]
    routing_operations = plan["routing_operations"]
    simulated_operations = plan["simulated_operations"]

    # The one piece deliberately NOT relocated: the plain-English verdict
    # is still Ledger's own Production Planning Agent, rendering judgment
    # on top of the real facts APS Platform just computed — same pattern
    # as every other agent this session, reading real data rather than
    # producing it.
    decision = await production_planning_agent(
        product_name=product_name,
        quantity=quantity,
        required_date=required_date,
        materials=materials,
        routing_operations=routing_operations,
        simulated_operations=simulated_operations,
        scheduling_conflicts_detected=plan.get("scheduling_conflicts_detected", 0),
    )

    # Deterministic safety net (agreed with the user: "the service must
    # never hide the reason") — a real shortage always reports
    # MATERIAL_SHORTAGE regardless of what the LLM classified it as.
    #
    # Phase 2 extends the same principle to the other real deterministic
    # fact scheduling-service now reports: whether every routing operation
    # actually got placed (operations_not_placed), and whether any of them
    # only fit after the scheduler's own bounded extended-horizon retry
    # (needed_extended_horizon — see pipeline.ts's EXTENDED_HORIZON_DAYS).
    # Both come straight from the real scheduling engine, never the LLM.
    # The LLM's own judgment (decision.status) is trusted only for the
    # PASS/WARNING distinction, and only once these deterministic facts
    # already show there's no shortage and nothing left unplaced — even
    # then, anything it returns outside PASS/WARNING is treated as WARNING
    # rather than trusted, so it can never reassert an UNPLANNABLE-style
    # verdict the facts don't support.
    has_shortage = plan.get("has_shortage", False)
    operations_not_placed = plan.get(
        "operations_not_placed", len(routing_operations) - len(simulated_operations)
    )
    needed_extended_horizon = plan.get("needed_extended_horizon", False)

    if has_shortage:
        verdict = "MATERIAL_SHORTAGE"
    elif operations_not_placed > 0:
        # The scheduler already retried once at its own extended horizon
        # (inside scheduling-service, before this ever returns) and still
        # couldn't place everything — a real, deterministic "nothing
        # further out helped either" result, not a guess.
        verdict = "PLANNER_REVIEW"
    elif needed_extended_horizon:
        # Every operation IS placed — just not within the normal horizon.
        # A valid, real production plan exists (real dates, real machines,
        # already in simulated_operations); it's just further out than usual.
        verdict = "WAITING_FOR_PRODUCTION_SLOT"
    else:
        verdict = decision.status if decision.status in ("PASS", "WARNING") else "WARNING"

    return {
        "verdict": verdict,
        "explanation": decision.explanation,
        "materials": materials,
        "routing_operations": routing_operations,
        "simulated_operations": simulated_operations,
        "production_order_id": plan["production_order_id"],
        "plant_id": plan.get("plant_id", MANUFACTURING_PLANT_ID),
        "configuration_notes": configuration_notes,
        "procurement_plan": plan.get("procurement_plan", []),
        "quantity": quantity,
    }


async def _commit_production_plan(production_order_id: str, plant_id: str, billing_context: dict | None = None) -> dict:
    """Post-approval only — the real, committing counterpart to
    _plan_production_via_manufacturing_services's what-if preview.

    billing_context (sales_order_id/customer/product/price/quantity) is
    stored on the TS ProductionOrder's metadata — the only place Python's
    sales_order_id can live on the TS side. Without it, the shop floor
    finishing every operation (mes-integration's completion webhook,
    POST /production-orders/{id}/complete) would have nothing to bill
    against; this is what closes that Order-to-Cash loop."""
    # Relocated to APS Platform, same reasoning as the planning side —
    # only ever called after a human has already approved on Ledger, so
    # this carries out a decision already made rather than making one.
    return await mfg.commit_production_plan(production_order_id, plant_id, billing_context)


async def _execute_production_plan(state: SalesState, production_plan: dict | None) -> dict:
    """Replays an already-decided production plan (MTO/CTO/HYBRID's
    production leg) — no re-planning, no new LLM call."""
    # Phase 2: PLANNER_REVIEW has a real production_order_id (the plan was
    # created, some operations placed) but genuinely couldn't place every
    # operation even with the extended-horizon retry — must not be
    # committed as if it were complete. PLANNING_CONFIGURATION_ISSUE always
    # has production_order_id=None already, so it's caught by the second
    # clause regardless; listed explicitly anyway so this guard reads as
    # the full, honest list of blocking verdicts rather than relying on a
    # side-effect of how one of them happens to be shaped.
    # WAITING_FOR_PRODUCTION_SLOT is deliberately NOT here — every
    # operation IS placed, just beyond the normal horizon, so it's a real,
    # complete, committable plan.
    if not production_plan or production_plan.get("verdict") in ("PLANNING_CONFIGURATION_ISSUE", "PLANNER_REVIEW") or not production_plan.get("production_order_id"):
        production_fulfillment_line_id = (state.get("fulfillment_line_ids") or {}).get("PRODUCTION")
        if production_fulfillment_line_id:
            try:
                await order_domain.patch_fulfillment_line(production_fulfillment_line_id, status="FAILED")
            except Exception:
                logger.warning("Could not mark PRODUCTION FulfillmentLine %s FAILED", production_fulfillment_line_id, exc_info=True)
        return {
            "status": "FULFILLMENT_FAILED",
            "production_order_id": None,
            "scheduled_operations": [],
            "purchase_orders": [],
            "response": state["response"] + (
                f" Production could not be planned: {production_plan.get('explanation') if production_plan else 'no plan available'}."
            ),
        }

    # quantity comes from the plan itself (split["to_produce"]), not
    # state["quantity"] (the full order) — for HYBRID only the produced
    # portion goes through this leg, the rest is already delivered/billed
    # by _deliver_and_bill's stock leg, so billing this leg against the
    # full order quantity would double-bill it.
    billing_context = {
        "salesOrderId": state.get("sales_order_id"),
        "customerId": state.get("customer_id"),
        "customerName": state.get("customer_name"),
        "productId": state.get("product_id"),
        "productName": state.get("product_name"),
        "price": state.get("price"),
        "quantity": production_plan.get("quantity"),
        # Order-to-production Phase 1: the real Postgres SalesOrder.id, when
        # the dual-write succeeded — see apsAgent.ts's commitProduction,
        # which sets ProductionOrder.salesOrderId from this alongside the
        # existing metadata write.
        "realSalesOrderId": state.get("real_sales_order_id"),
    }
    commit = await _commit_production_plan(production_plan["production_order_id"], production_plan["plant_id"], billing_context)
    production_fulfillment_line_id = (state.get("fulfillment_line_ids") or {}).get("PRODUCTION")
    if production_fulfillment_line_id:
        try:
            # Order Orchestration (Phase 2): the real, already-scheduled
            # completion date — the latest scheduledEnd across every real
            # operation APS just placed — never invented here. None of
            # these operations exist yet when MATERIAL_SHORTAGE holds up
            # some of them, so this can legitimately be empty.
            scheduled_ops = commit.get("scheduled_operations") or []
            promised_date = max((op["scheduledEnd"] for op in scheduled_ops), default=None)
            # EXECUTION_CREATED (not FULFILLED yet): the real execution
            # document now exists and is linked, but production itself
            # (scheduling, shop floor, completion) is still ahead — APS
            # remains solely responsible for that, untouched here.
            await order_domain.patch_fulfillment_line(
                production_fulfillment_line_id,
                production_order_id=commit["production_order_id"],
                status="EXECUTION_CREATED",
                promised_date=promised_date,
            )
        except Exception:
            logger.warning("Could not link FulfillmentLine %s to ProductionOrder %s", production_fulfillment_line_id, commit["production_order_id"], exc_info=True)
    has_shortage = production_plan["verdict"] == "MATERIAL_SHORTAGE"
    ops_text = "; ".join(
        f"{op.get('routingOperationId', '?')} on {op.get('machineId', '?')}"
        for op in commit["scheduled_operations"]
    ) or "no operations scheduled"

    # Real purchase orders for the shortfall — replaying the exact plan
    # already shown pre-approval (same vendor, same quantities), not a
    # fresh decision. Approving now means "produce AND order the missing
    # components," not just "produce, and hope the shortage resolves
    # itself" — see _plan_production_via_manufacturing_services.
    purchase_orders = []
    for line in production_plan.get("procurement_plan", []):
        po = await mfg.create_purchase_order(line["vendor_id"], line["component_id"], line["quantity"], line["expected_date"])
        purchase_orders.append({**line, "purchase_order_id": po["id"]})
    procurement_text = (
        " Procurement: " + "; ".join(
            f"{po['purchase_order_id']}: {po['quantity']} x {po['component_name']} from {po['vendor_name']}, expected {po['expected_date']}"
            for po in purchase_orders
        ) + "."
        if purchase_orders else ""
    )

    return {
        "status": "IN_PRODUCTION" if not has_shortage else "AWAITING_MATERIALS",
        "production_order_id": commit["production_order_id"],
        "scheduled_operations": commit["scheduled_operations"],
        "purchase_orders": purchase_orders,
        "response": state["response"] + (
            f" Production Order {commit['production_order_id']} released ({commit['status']}). "
            f"Scheduled: {ops_text}."
        ) + procurement_text,
    }


async def _execute_hybrid_with_plan(state: SalesState, production_plan: dict | None) -> dict:
    """HYBRID's stock leg (reserve + deliver/bill, same as mts_node) plus
    its production leg via the real manufacturing services — mirrors
    hybrid_node's shape, replaying the pre-decided production_plan
    instead of creating a production order fresh."""
    reservation = erp.reserve_stock(
        sales_order_id=state["sales_order_id"],
        product_id=state["product_id"],
        product_name=state["product_name"],
        quantity=state["fulfillment_from_stock"],
    )
    if not reservation["reserved"]:
        await _patch_stock_execution(state, {"status": "FULFILLMENT_FAILED"})
        return {
            "status": "FULFILLMENT_FAILED",
            "response": state["response"] + f" Stock reservation failed: {reservation['reason']}",
        }

    billing_update = await _deliver_and_bill(state, state["fulfillment_from_stock"])
    # Same two-step PENDING -> ALLOCATED -> FULFILLED transition
    # _patch_stock_execution uses for the plain-MTS case — reused here
    # rather than duplicated, one canonical path for "the STOCK leg
    # succeeded" regardless of which branch reached it. Real promised date
    # (Order Orchestration, Phase 2) — the real confirmed delivery date
    # _deliver_and_bill already computed, never invented here.
    await _patch_stock_execution(state, {
        "reservation_id": reservation["reservation_id"],
        "confirmed_delivery_date": billing_update["confirmed_delivery_date"],
    })

    production_update = await _execute_production_plan(state, production_plan)

    # Real bug found live (agreed with the user): this return dict used to
    # drop production_order_id/scheduled_operations/purchase_orders
    # entirely — a HYBRID order's production leg genuinely ran (a real
    # ProductionOrder gets released, real operations get scheduled), but
    # the caller (run_post_approval_fulfillment, then approvals.py's
    # mark_executed) never saw the id, so it was never linked into the
    # execution result, never surfaced to the frontend's "Orders On The
    # Floor" tracker, and the order sat there real but invisible. Every
    # HYBRID order was affected — not an edge case.
    return {
        "delivery_id": billing_update["delivery_id"],
        "delivery_status": billing_update["delivery_status"],
        "confirmed_delivery_date": billing_update["confirmed_delivery_date"],
        "invoice_id": billing_update["invoice_id"],
        "invoice_status": billing_update["invoice_status"],
        "invoice_amount": billing_update["invoice_amount"],
        "production_order_id": production_update["production_order_id"],
        "scheduled_operations": production_update["scheduled_operations"],
        "purchase_orders": production_update["purchase_orders"],
        "status": "PARTIALLY_IN_PRODUCTION" if production_update["status"] != "FULFILLMENT_FAILED" else "FULFILLMENT_FAILED",
        "response": (
            state["response"]
            + f" Reserved {state['fulfillment_from_stock']} from stock (reservation {reservation['reservation_id']})."
            + billing_update["note"]
            + production_update["response"].removeprefix(state["response"])
        ),
    }


async def _plan_vendor_sourcing(product_id: str, product_name: str | None, quantity: int, lead_time_days: int | None) -> dict:
    """Pre-approval vendor pick for THIRD_PARTY/TRADING — pure mock-ERP
    side, no TS calls (agreed with the user: this stays exactly the two
    distinct existing lifecycles it already is; only the timing of the
    decision moves, not what TRADING/THIRD_PARTY mean)."""
    vendors = erp.get_vendors_for_product(product_id)
    if not vendors:
        return {"vendors_available": False}

    target_completion_date = compute_target_completion_date(lead_time_days)
    decision = await procurement_agent(
        shortages=[{
            "component_id": product_id,
            "component_name": product_name,
            "shortage": quantity,
            "vendors": vendors,
        }],
        target_completion_date=target_completion_date,
    )
    if not decision.choices:
        return {"vendors_available": False}

    choice = decision.choices[0]
    vendor = next((v for v in vendors if v["vendor_id"] == choice.vendor_id), vendors[0])
    drop_ship = bool(vendor.get("ships_direct_to_customer"))
    return {
        "vendors_available": True,
        "vendor_id": vendor["vendor_id"],
        "vendor_name": vendor["vendor_name"],
        "unit_cost": vendor["unit_cost"],
        "lead_time_days": vendor["lead_time_days"],
        "drop_ship": drop_ship,
        "strategy_label": "THIRD_PARTY" if drop_ship else "TRADING",
        "reasoning": choice.reasoning,
        "target_completion_date": target_completion_date,
    }


def _execute_vendor_sourcing(state: SalesState, vendor_plan: dict) -> dict:
    """Replays an already-decided vendor plan — no re-decision, no new
    LLM call. Mirrors third_party_node's tail exactly."""
    order = create_trading_order(
        sales_order_id=state["sales_order_id"],
        product_id=state["product_id"],
        product_name=state["product_name"],
        vendor_id=vendor_plan["vendor_id"],
        vendor_name=vendor_plan["vendor_name"],
        quantity=state["fulfillment_to_produce"],
        unit_cost=vendor_plan["unit_cost"],
        lead_time_days=vendor_plan["lead_time_days"],
        drop_ship=vendor_plan["drop_ship"],
    )
    if not order["created"]:
        return {
            "status": "FULFILLMENT_FAILED",
            "response": state["response"] + f" Trading order failed: {order['reason']}",
        }

    if vendor_plan["drop_ship"]:
        route_note = (
            f"{vendor_plan['vendor_name']} ships this directly to the customer — it never enters "
            f"our warehouse or our inventory."
        )
    else:
        route_note = (
            f"{vendor_plan['vendor_name']} ships this to us first — it's received, quality-checked, "
            f"and warehoused into our own inventory before we dispatch it to the customer."
        )

    return {
        "fulfillment_strategy": vendor_plan["strategy_label"],
        "status": "SOURCING",
        # Fulfillment architecture hardening: the real execution reference
        # (this strategy has no Postgres FK — see FulfillmentLine.executionReference)
        # for the caller to patch onto the BUY/DROP_SHIP FulfillmentLine.
        "trading_order_id": order["trading_order_id"],
        # Order Orchestration (Phase 2): the real vendor-quoted arrival date.
        "expected_arrival": order["expected_arrival"],
        "response": state["response"] + (
            f" Sourced from vendor: Trading Order {order['trading_order_id']} — "
            f"{state['fulfillment_to_produce']} x {state['product_name']} from "
            f"{vendor_plan['vendor_name']}, arriving {order['expected_arrival']}. "
            f"{vendor_plan['reasoning']} {route_note}"
        ),
    }


async def mto_node(state: SalesState):
    assessment = _assess_materials(state["product_id"], state["fulfillment_to_produce"])
    has_shortage = bool(assessment["shortages"])
    initial_status = "AWAITING_MATERIALS" if has_shortage else "PLANNED"

    result = erp.create_production_order(
        sales_order_id=state["sales_order_id"],
        product_id=state["product_id"],
        product_name=state["product_name"],
        quantity=state["fulfillment_to_produce"],
        lead_time_days=state["lead_time_days"],
        initial_status=initial_status,
    )
    if not result["created"]:
        return {
            "status": "FULFILLMENT_FAILED",
            "response": state["response"] + f" Production order failed: {result['reason']}",
        }

    procurement_note = await _procure_shortages(
        assessment, result["production_order_id"], result["target_completion_date"]
    )
    return {
        "status": "IN_PRODUCTION" if not has_shortage else "AWAITING_MATERIALS",
        "response": state["response"] + (
            f" Production Order {result['production_order_id']} created "
            f"({result['status']}), target completion {result['target_completion_date']}."
        ) + procurement_note,
    }


# Configuration Agent extracts what the customer actually asked for from
# their original message — it does not validate those options are real
# (no BOM/configuration-rules data exists to validate against yet), it
# only turns free text into structured data for the production record.
async def cto_node(state: SalesState):
    configuration = await configuration_agent(
        product_name=state["product_name"],
        user_message=state["user_message"],
    )
    if configuration.options:
        options_text = "; ".join(f"{o.attribute}: {o.value}" for o in configuration.options)
        configuration_notes = f"Requested configuration: {options_text}. {configuration.notes}"
    else:
        configuration_notes = configuration.notes

    # Checked against the base product's BOM — configuration-specific
    # variants (e.g. different RAM per option) aren't modeled, same honest
    # limit as Configuration Agent not validating the options themselves.
    assessment = _assess_materials(state["product_id"], state["fulfillment_to_produce"])
    has_shortage = bool(assessment["shortages"])
    initial_status = "AWAITING_MATERIALS" if has_shortage else "PLANNED"

    result = erp.create_production_order(
        sales_order_id=state["sales_order_id"],
        product_id=state["product_id"],
        product_name=state["product_name"],
        quantity=state["fulfillment_to_produce"],
        lead_time_days=state["lead_time_days"],
        requires_configuration=True,
        configuration_notes=configuration_notes,
        initial_status=initial_status,
    )

    base_update = {
        "configuration_options": [o.model_dump() for o in configuration.options],
    }
    if result["created"]:
        procurement_note = await _procure_shortages(
            assessment, result["production_order_id"], result["target_completion_date"]
        )
        return {
            **base_update,
            "status": "IN_PRODUCTION" if not has_shortage else "AWAITING_MATERIALS",
            "response": state["response"] + (
                f" Production Order {result['production_order_id']} created "
                f"({configuration_notes}), target completion "
                f"{result['target_completion_date']}."
            ) + procurement_note,
        }
    return {
        **base_update,
        "status": "FULFILLMENT_FAILED",
        "response": state["response"] + f" Production order failed: {result['reason']}",
    }


async def hybrid_node(state: SalesState):
    reservation = {"reserved": True, "allocations": [], "reservation_id": None}
    if state["fulfillment_from_stock"] > 0:
        reservation = erp.reserve_stock(
            sales_order_id=state["sales_order_id"],
            product_id=state["product_id"],
            product_name=state["product_name"],
            quantity=state["fulfillment_from_stock"],
        )

    production = {"created": True, "production_order_id": None, "target_completion_date": None}
    if state["fulfillment_to_produce"] > 0:
        production = erp.create_production_order(
            sales_order_id=state["sales_order_id"],
            product_id=state["product_id"],
            product_name=state["product_name"],
            quantity=state["fulfillment_to_produce"],
            lead_time_days=state["lead_time_days"],
        )

    if reservation["reserved"] and production["created"]:
        parts = []
        billing_update = {"delivery_id": None, "delivery_status": None, "confirmed_delivery_date": None, "invoice_id": None, "invoice_status": None, "invoice_amount": None, "note": ""}
        if state["fulfillment_from_stock"] > 0:
            parts.append(
                f"reserved {state['fulfillment_from_stock']} from stock "
                f"(reservation {reservation['reservation_id']})"
            )
            # Only the stock leg is actually ready to ship/bill now — the
            # produced leg isn't real yet.
            billing_update = await _deliver_and_bill(state, state["fulfillment_from_stock"])
        if state["fulfillment_to_produce"] > 0:
            parts.append(
                f"Production Order {production['production_order_id']} created "
                f"for the remaining {state['fulfillment_to_produce']}"
            )
        return {
            "delivery_id": billing_update["delivery_id"],
            "delivery_status": billing_update["delivery_status"],
            "confirmed_delivery_date": billing_update["confirmed_delivery_date"],
            "invoice_id": billing_update["invoice_id"],
            "invoice_status": billing_update["invoice_status"],
            "invoice_amount": billing_update["invoice_amount"],
            "status": "PARTIALLY_IN_PRODUCTION",
            "response": state["response"] + " " + "; ".join(parts) + "." + billing_update["note"],
        }

    reasons = []
    if not reservation["reserved"]:
        reasons.append(reservation.get("reason", "stock reservation failed"))
    if not production["created"]:
        reasons.append(production.get("reason", "production order failed"))
    return {
        "status": "FULFILLMENT_FAILED",
        "response": state["response"] + " Fulfillment failed: " + "; ".join(reasons),
    }


# Trading — sourcing a finished product from a vendor instead of
# manufacturing it. Reuses Procurement Agent's exact vendor lead-time/cost
# tradeoff logic: choosing a vendor for a finished product is the same
# decision as choosing one for a raw material component, just a different
# level of the same problem. Only real vendor data makes this possible —
# most products have none (this company makes what it sells for those),
# so it honestly falls back to manual handling rather than faking a source.
async def third_party_node(state: SalesState):
    vendors = erp.get_vendors_for_product(state["product_id"])
    if not vendors:
        return await unfulfillable_node(state)

    target_completion_date = compute_target_completion_date(state["lead_time_days"])
    decision = await procurement_agent(
        shortages=[{
            "component_id": state["product_id"],
            "component_name": state["product_name"],
            "shortage": state["fulfillment_to_produce"],
            "vendors": vendors,
        }],
        target_completion_date=target_completion_date,
    )
    if not decision.choices:
        return await unfulfillable_node(state)

    choice = decision.choices[0]
    vendor = next((v for v in vendors if v["vendor_id"] == choice.vendor_id), vendors[0])

    # The real distinction (agreed with the user, matching how SAP itself
    # separates these): does THIS vendor ship straight to the customer,
    # or through our own warehouse first? Decided here, deterministically,
    # from real vendor-master data — not guessed by the LLM, and not
    # knowable before a specific vendor was actually chosen.
    drop_ship = bool(vendor.get("ships_direct_to_customer"))

    order = create_trading_order(
        sales_order_id=state["sales_order_id"],
        product_id=state["product_id"],
        product_name=state["product_name"],
        vendor_id=vendor["vendor_id"],
        vendor_name=vendor["vendor_name"],
        quantity=state["fulfillment_to_produce"],
        unit_cost=vendor["unit_cost"],
        lead_time_days=vendor["lead_time_days"],
        drop_ship=drop_ship,
    )
    if not order["created"]:
        return {
            "status": "FULFILLMENT_FAILED",
            "response": state["response"] + f" Trading order failed: {order['reason']}",
        }

    if drop_ship:
        strategy_label = "THIRD_PARTY"
        route_note = (
            f"{vendor['vendor_name']} ships this directly to the customer — it never enters "
            f"our warehouse or our inventory."
        )
    else:
        strategy_label = "TRADING"
        route_note = (
            f"{vendor['vendor_name']} ships this to us first — it's received, quality-checked, "
            f"and warehoused into our own inventory before we dispatch it to the customer."
        )

    return {
        "fulfillment_strategy": strategy_label,
        "status": "SOURCING",
        "response": state["response"] + (
            f" Sourced from vendor: Trading Order {order['trading_order_id']} — "
            f"{state['fulfillment_to_produce']} x {state['product_name']} from "
            f"{vendor['vendor_name']}, arriving {order['expected_arrival']}. "
            f"{choice.reasoning} {route_note}"
        ),
    }


# The rest of Trading's lifecycle — Goods Receipt / QC / Warehousing —
# happens through update_trading_order_status() directly (ORDERED ->
# RECEIVED -> QC_PASSED/QC_FAILED -> WAREHOUSED), same real,
# person-triggered pattern as update_service_order_status(). Only the
# final Dispatch step needs an agent call (Billing Agent decides
# terms/notes), so it's a standalone async function here rather than a
# plain tool — mirrors _deliver_and_bill, called once WAREHOUSED, not
# reached through the conversational graph (there's no chat message that
# means "dispatch trading order TO0004"; this is an operational trigger,
# same category as resolve_return_inspection).
async def dispatch_trading_order(trading_order_id: str) -> dict:
    trading_order = find_trading_order(trading_order_id)
    if trading_order is None:
        return {"dispatched": False, "reason": f"No trading order found with id {trading_order_id}"}
    if trading_order["status"] != "WAREHOUSED":
        return {
            "dispatched": False,
            "reason": f"{trading_order_id} must be WAREHOUSED before it can be dispatched (status: {trading_order['status']}).",
        }

    sales_order = find_sales_order(trading_order["sales_order_id"])
    if sales_order is None:
        return {"dispatched": False, "reason": f"Referenced sales order {trading_order['sales_order_id']} does not exist."}

    billing_state = {
        "sales_order_id": sales_order["sales_order_id"],
        "customer_id": sales_order["customer_id"],
        "customer_name": sales_order["customer_name"],
        "product_id": trading_order["product_id"],
        "product_name": trading_order["product_name"],
        "price": sales_order["unit_price"],
        "quantity": sales_order["quantity"],
    }
    billing_update = await _deliver_and_bill(billing_state, trading_order["quantity"])

    if billing_update["delivery_id"] is None:
        return {"dispatched": False, "reason": f"Dispatch failed:{billing_update['note']}"}

    mark_trading_order_dispatched(trading_order_id)

    return {
        "dispatched": True,
        "trading_order_id": trading_order_id,
        "delivery_id": billing_update["delivery_id"],
        "invoice_id": billing_update["invoice_id"],
        "invoice_amount": billing_update["invoice_amount"],
        "note": f"Trading Order {trading_order_id} dispatched.{billing_update['note']}",
    }


# The drop-ship counterpart to dispatch_trading_order() — same shape,
# same real delivery/invoice at the end, but requires SHIPPED (not
# WAREHOUSED) and — this is the actual point of the distinction —
# never touches erp inventory at all, because the vendor shipped this
# straight to the customer. Nothing here credits stock.
async def deliver_drop_ship_order(trading_order_id: str) -> dict:
    trading_order = find_trading_order(trading_order_id)
    if trading_order is None:
        return {"dispatched": False, "reason": f"No trading order found with id {trading_order_id}"}
    if trading_order["status"] != "SHIPPED":
        return {
            "dispatched": False,
            "reason": f"{trading_order_id} must be SHIPPED before it can be marked delivered (status: {trading_order['status']}).",
        }

    sales_order = find_sales_order(trading_order["sales_order_id"])
    if sales_order is None:
        return {"dispatched": False, "reason": f"Referenced sales order {trading_order['sales_order_id']} does not exist."}

    billing_state = {
        "sales_order_id": sales_order["sales_order_id"],
        "customer_id": sales_order["customer_id"],
        "customer_name": sales_order["customer_name"],
        "product_id": trading_order["product_id"],
        "product_name": trading_order["product_name"],
        "price": sales_order["unit_price"],
        "quantity": sales_order["quantity"],
    }
    billing_update = await _deliver_and_bill(billing_state, trading_order["quantity"])

    if billing_update["delivery_id"] is None:
        return {"dispatched": False, "reason": f"Delivery failed:{billing_update['note']}"}

    mark_trading_order_delivered(trading_order_id)

    return {
        "dispatched": True,
        "trading_order_id": trading_order_id,
        "delivery_id": billing_update["delivery_id"],
        "invoice_id": billing_update["invoice_id"],
        "invoice_amount": billing_update["invoice_amount"],
        "note": f"Trading Order {trading_order_id} (drop-ship) delivered — the vendor shipped this directly to the customer.{billing_update['note']}",
    }


async def unfulfillable_node(state: SalesState):
    strategy = state["fulfillment_strategy"]
    if strategy == "THIRD_PARTY":
        reason = f"no vendor is on file for {state['product_name']}"
    else:
        reason = "no other-plant/other-company data exists in this system yet"
    return {
        "status": "PENDING_MANUAL_ACTION",
        "response": state["response"] + (
            f" {strategy} fulfillment needs manual handling — {reason}."
        ),
    }


async def not_implemented_node(state: SalesState):
    return {"status": "NOT_IMPLEMENTED", "response": f"{state['entry_type']} ({state['process']}) is not implemented yet"}


builder = StateGraph(SalesState)

builder.add_node("intent", intent_node)
builder.add_node("needs_clarification", needs_clarification_node)
builder.add_node("understanding", understanding_node)
builder.add_node("reference_resolution", reference_resolution_node)
builder.add_node("unclear", unclear_node)
builder.add_node("unsupported", unsupported_node)
builder.add_node("context", context_node)
builder.add_node("composed_execution", composed_execution_node)
builder.add_node("process", process_node)
builder.add_node("pre_sales", pre_sales_node)
builder.add_node("direct_sales", direct_sales_node)
builder.add_node("post_sales", post_sales_node)
builder.add_node("service", service_node)
builder.add_node("subscription", subscription_node)
builder.add_node("project", project_node)
builder.add_node("export", export_node)
builder.add_node("consignment", consignment_node)
builder.add_node("financial", financial_node)
builder.add_node("credit_check", credit_check_node)
builder.add_node("credit_hold", credit_hold_node)
builder.add_node("fulfillment_decision", fulfillment_decision_node)
builder.add_node("mts", mts_node)
builder.add_node("mto", mto_node)
builder.add_node("cto", cto_node)
builder.add_node("hybrid", hybrid_node)
builder.add_node("third_party", third_party_node)
builder.add_node("unfulfillable", unfulfillable_node)
builder.add_node("not_implemented", not_implemented_node)

builder.add_edge(START, "intent")
builder.add_conditional_edges(
    "intent",
    intent_router,
    {
        "needs_clarification": "needs_clarification",
        "context": "understanding",
    },
)
builder.add_edge("needs_clarification", END)
builder.add_conditional_edges(
    "understanding",
    understanding_router,
    {
        "unsupported": "unsupported",
        "context": "reference_resolution",
    },
)
builder.add_edge("reference_resolution", "context")
builder.add_edge("unclear", END)
builder.add_edge("unsupported", END)
builder.add_node("reschedule_request", reschedule_request_node)
builder.add_node("inventory_quality_request", inventory_quality_request_node)
builder.add_conditional_edges(
    "context",
    composed_execution_router,
    {
        "composed_execution": "composed_execution",
        "reschedule_request": "reschedule_request",
        "inventory_quality_request": "inventory_quality_request",
        "process": "process",
    },
)
builder.add_edge("composed_execution", END)
builder.add_edge("reschedule_request", END)
builder.add_edge("inventory_quality_request", END)
builder.add_conditional_edges(
    "process",
    entry_router,
    {
        "unclear": "unclear",
        "pre_sales": "pre_sales",
        "direct_sales": "direct_sales",
        "post_sales": "post_sales",
        "service": "service",
        "subscription": "subscription",
        "project": "project",
        "export": "export",
        "consignment": "consignment",
        "financial": "financial",
        "not_implemented": "not_implemented",
    },
)
builder.add_edge("pre_sales", END)
builder.add_edge("post_sales", END)
builder.add_edge("service", END)
builder.add_edge("subscription", END)
builder.add_edge("project", END)
builder.add_edge("export", END)
builder.add_edge("consignment", END)
builder.add_edge("financial", END)
builder.add_conditional_edges(
    "direct_sales",
    direct_sales_router,
    {
        "end": END,
        "credit_check": "credit_check",
    },
)
builder.add_conditional_edges(
    "credit_check",
    credit_router,
    {
        "credit_hold": "credit_hold",
        "fulfillment_decision": "fulfillment_decision",
    },
)
builder.add_edge("credit_hold", END)
builder.add_conditional_edges(
    "fulfillment_decision",
    fulfillment_router,
    {
        "mts": "mts",
        "mto": "mto",
        "cto": "cto",
        "hybrid": "hybrid",
        "third_party": "third_party",
        "unfulfillable": "unfulfillable",
    },
)
builder.add_edge("mts", END)
builder.add_edge("mto", END)
builder.add_edge("cto", END)
builder.add_edge("hybrid", END)
builder.add_edge("third_party", END)
builder.add_edge("unfulfillable", END)
builder.add_edge("not_implemented", END)

graph = builder.compile()
