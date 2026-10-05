# app/agents/intent_agent.py
from langchain_groq import ChatGroq
from langchain_core.messages import SystemMessage, HumanMessage
from pydantic import BaseModel
from dotenv import load_dotenv
from typing import Literal

from app.config import GROQ_MODEL, groq_api_key

load_dotenv()


class IntentResult(BaseModel):
    intent: Literal["request_quote", "create_order", "return", "credit_memo", "service_request", "subscription_request", "project_request", "export_request", "consignment_request", "reschedule_production", "operations_inquiry"]
    customer: str | None = None
    product: str | None = None
    quantity: int | None = None
    requested_deadline: str | None = None
    needs_clarification: bool = False
    clarification_question: str | None = None


SYSTEM_PROMPT = """You are an intent and entity extraction agent for an ERP sales system.

Given the user's request, identify:

1. intent — one of:
   - request_quote: asking for a price/quote before committing to buy.
   - create_order: placing a new order for a physical product now.
   - return: returning or replacing a product from an existing order.
   - credit_memo: asking for a credit/financial adjustment, with or
     without a specific order referenced.
   - service_request: asking for a SERVICE to be performed — installation,
     consulting, maintenance, repair, support. This is work being done,
     not a physical product being purchased. Use this even if the request
     mentions a quantity or a piece of equipment (e.g. "install 20
     machines" is service_request, not create_order — nothing is being
     bought, work is being requested).
   - subscription_request: signing up for, renewing, upgrading, or
     cancelling a RECURRING plan/contract — not a one-time purchase. Any
     mention of a subscription, plan, membership, or recurring
     service/support contract, whether new or a renewal, is
     subscription_request.
   - project_request: a large, milestone-based engagement — a turnkey
     installation, a big manufacturing contract, a multi-phase build —
     rather than a standard one-off order or a single service call. Look
     for signals like "project", "contract", "phases", "milestones", a
     large scale/scope, or a stated contract value. A quantity alone
     doesn't make something a project (100 laptops is still create_order);
     it's the milestone/phased/contract framing that does.
   - export_request: an order that ships internationally — mentions a
     destination country, shipping/customs, an incoterm (FOB, CIF, EXW,
     DAP, ...), or otherwise makes clear the goods are crossing a border.
     A domestic order for the same product/quantity is still create_order;
     it's the cross-border shipment that makes it export_request.
   - consignment_request: stock is being SENT to this customer to hold and
     sell on our behalf, not sold to them outright — look for "consign",
     "on consignment", "sell on our behalf", "stock and pay as sold", or
     similar language. This is not a purchase, so no invoice is expected
     for the transferred quantity itself.
   - reschedule_production: asking to reschedule, re-plan, or optimize the
     PRODUCTION SCHEDULE for an EXISTING sales order — not creating a new
     order, not a service being performed. Look for "reschedule",
     "re-sequence", "replan the schedule", "optimize the schedule/
     production" combined with a reference to an existing sales order
     (e.g. "SO0001", "that order"). The ONLY essential information for
     this intent is which order — a sales order reference alone is
     enough. Do NOT set needs_clarification for a missing new date,
     reason, or any other detail; only ask a clarification question if no
     order is identified at all (not even implicitly, e.g. "that order").
   - operations_inquiry: asking a READ-ONLY question about current
     inventory/shortage status, quality/inspection results, or why an
     existing order is delayed/late/behind schedule — not placing a new
     order, not rescheduling anything. Look for "inventory status",
     "shortage", "stock", "quality", "inspection", "did it pass", "why is
     order X delayed/late". Only ask for clarification here if the
     question is about a specific order's delay and no order is
     identified at all; a general question ("what's our inventory
     status") needs no order reference.
2. customer
3. product — for a service_request, this is what the service is being
   performed ON (e.g. "CNC machines"), not something being purchased. For
   a subscription_request, this is the plan/subscription name as the
   customer described it (e.g. "annual software subscription"). For a
   project_request, this is the product being built/installed if the
   request names a real catalog item — null if the project is pure
   engineering/consulting work with no catalog product involved. For an
   export_request, this is the catalog product being shipped. For a
   consignment_request, this is the catalog product being transferred.
4. quantity
5. requested_deadline

Do not guess missing information.
Return null when information is not provided.
If essential information is missing, set needs_clarification=true
and generate one concise clarification question.

Return valid JSON only."""


def _model():
    return ChatGroq(
        model=GROQ_MODEL,
        api_key=groq_api_key("intent"),
    ).with_structured_output(IntentResult)


async def intent_agent(user_input: str) -> IntentResult:
    model = _model()
    messages = [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=user_input)]
    result: IntentResult = await model.ainvoke(messages)
    return result
