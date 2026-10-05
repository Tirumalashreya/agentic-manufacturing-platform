# app/agents/billing_agent.py
from groq import BadRequestError
from langchain_groq import ChatGroq
from langchain_core.messages import SystemMessage, HumanMessage
from dotenv import load_dotenv
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_fixed

from app.config import GROQ_MODEL, groq_api_key
from app.schemas.billing import BillingDecision

load_dotenv()


SYSTEM_PROMPT = """You are the billing agent for an ERP sales system. A
delivery has just happened — some quantity of a Sales Order has shipped,
possibly the full order or only part of it.

Decide:
- payment_terms_days: how many days the customer has to pay. Always use
  30 (Net 30) — this system does not yet capture a customer-specific
  payment term, and a requested delivery date is not a payment term, so
  never derive this from anything delivery-related.
- notes: one concise sentence. If this is a PARTIAL delivery (delivered
  quantity is less than the total order quantity), say so plainly and
  mention that the remainder will be billed separately once fulfilled.

You are NOT computing the invoice amount — that is quantity_delivered *
unit_price, done deterministically elsewhere, not by you.

Return valid JSON only."""


def _model():
    return ChatGroq(
        model=GROQ_MODEL,
        api_key=groq_api_key("billing"),
    ).with_structured_output(BillingDecision)


def _is_malformed_tool_call(err: BaseException) -> bool:
    # Same Groq gpt-oss tool-calling flake documented in challenge.md,
    # observed here live in two variants: a bogus tool name ("json",
    # code tool_use_failed) and, observed later, the model dumping raw
    # reasoning text instead of calling the tool at all
    # (code output_parse_failed). Both are the same underlying
    # provider-side unreliability, not a real bad request.
    if not isinstance(err, BadRequestError):
        return False
    message = str(err)
    return "tool_use_failed" in message or "output_parse_failed" in message


@retry(
    retry=retry_if_exception(_is_malformed_tool_call),
    stop=stop_after_attempt(5),
    wait=wait_fixed(1),
    reraise=True,
)
async def _invoke(model, messages) -> BillingDecision:
    return await model.ainvoke(messages)


async def billing_agent(
    quantity_delivered: int,
    quantity_ordered: int,
    unit_price: float,
) -> BillingDecision:
    context = (
        f"quantity_delivered: {quantity_delivered}\n"
        f"quantity_ordered: {quantity_ordered}\n"
        f"unit_price: {unit_price}"
    )
    model = _model()
    messages = [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=context)]
    result: BillingDecision = await _invoke(model, messages)
    return result
