# app/agents/intent_agent.py
from langchain_groq import ChatGroq
from langchain_core.messages import SystemMessage, HumanMessage
from pydantic import BaseModel
from dotenv import load_dotenv
from typing import Literal

from app.config import GROQ_MODEL, groq_api_key

load_dotenv()


class IntentResult(BaseModel):
    intent: Literal["request_quote", "create_order", "return", "credit_memo", "service_request", "subscription_request"]
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
2. customer
3. product — for a service_request, this is what the service is being
   performed ON (e.g. "CNC machines"), not something being purchased. For
   a subscription_request, this is the plan/subscription name as the
   customer described it (e.g. "annual software subscription").
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
