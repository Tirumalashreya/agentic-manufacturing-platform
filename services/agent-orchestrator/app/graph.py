# app/graph.py
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
from app.agents.service_agent import service_agent
from app.agents.subscription_agent import subscription_agent
from app.agents.project_agent import project_agent
from app.agents.export_agent import export_agent
from app.agents.consignment_agent import consignment_agent
from app.agents.financial_agent import financial_agent
from app.erp.mock_erp_adapter import default_erp_adapter as erp
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


async def process_node(state: SalesState):
    result = await process_agent(
        intent=state["intent"],
        customer=state["customer"],
        product=state["product"],
        quantity=state["quantity"],
        requested_deadline=state["requested_deadline"],
        customer_exists=state["customer_exists"],
        customer_active=state["customer_active"],
        product_valid=state["product_valid"],
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
def entry_router(state: SalesState) -> str:
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
    decision = await financial_agent(state["user_message"])

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
    )
    if not delivery["created"]:
        return {
            "delivery_id": None,
            "delivery_status": "NOT_CREATED",
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
            "invoice_id": None,
            "invoice_status": "NOT_CREATED",
            "invoice_amount": None,
            "note": (
                f" Delivered {quantity} units (delivery {delivery['delivery_id']}), "
                f"but invoicing failed: {invoice['reason']}"
            ),
        }

    return {
        "delivery_id": delivery["delivery_id"],
        "delivery_status": delivery["status"],
        "invoice_id": invoice["invoice_id"],
        "invoice_status": invoice["status"],
        "invoice_amount": invoice["invoice_amount"],
        "note": (
            f" Delivered {quantity} units (delivery {delivery['delivery_id']}); "
            f"invoiced {invoice['invoice_id']} for {invoice['invoice_amount']}, "
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
        "invoice_id": billing_update["invoice_id"],
        "invoice_status": billing_update["invoice_status"],
        "invoice_amount": billing_update["invoice_amount"],
        "status": "BILLED" if billing_update["invoice_id"] else "FULFILLED",
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
        billing_update = {"delivery_id": None, "delivery_status": None, "invoice_id": None, "invoice_status": None, "invoice_amount": None, "note": ""}
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

    order = create_trading_order(
        sales_order_id=state["sales_order_id"],
        product_id=state["product_id"],
        product_name=state["product_name"],
        vendor_id=vendor["vendor_id"],
        vendor_name=vendor["vendor_name"],
        quantity=state["fulfillment_to_produce"],
        unit_cost=vendor["unit_cost"],
        lead_time_days=vendor["lead_time_days"],
    )
    if not order["created"]:
        return {
            "status": "FULFILLMENT_FAILED",
            "response": state["response"] + f" Trading order failed: {order['reason']}",
        }

    return {
        "status": "SOURCING",
        "response": state["response"] + (
            f" Sourced from vendor: Trading Order {order['trading_order_id']} — "
            f"{state['fulfillment_to_produce']} x {state['product_name']} from "
            f"{vendor['vendor_name']}, arriving {order['expected_arrival']}. "
            f"{choice.reasoning}"
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
builder.add_node("context", context_node)
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
        "context": "context",
    },
)
builder.add_edge("needs_clarification", END)
builder.add_edge("context", "process")
builder.add_conditional_edges(
    "process",
    entry_router,
    {
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
