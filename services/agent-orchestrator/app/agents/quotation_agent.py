# app/agents/quotation_agent.py
from groq import BadRequestError
from langchain_groq import ChatGroq
from langchain_core.messages import SystemMessage, HumanMessage
from dotenv import load_dotenv
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_fixed

from app.config import GROQ_MODEL, groq_api_key
from app.schemas.quotation import QuotationDecision, QuotationResult

load_dotenv()


SYSTEM_PROMPT = """You are the quotation agent for an ERP sales system.

Given a customer's product request and what we know from the ERP (catalog
price, stock on hand, production capability, lead time), decide two things:

- quoted_price: the unit price to quote. Use the given catalog price
  unchanged unless it is missing — never invent a discount. If catalog_price
  is missing, return null instead of guessing a price.
- valid_for_days: how many days this quote stays valid. Use 30 by default.
- notes: one or two concise sentences. Mention if stock on hand is below the
  requested quantity and a lead time will apply, or if the product needs to
  be produced rather than shipped from stock. If catalog_price is missing,
  say so plainly in the notes instead of quoting a price — a missing or
  unrecognized customer_name does NOT block quoting: pre-sales quotes
  routinely go to prospects who aren't in the customer master yet, so quote
  normally as long as the product and price are known.

Do not compute a total — that's handled outside this decision.

Return valid JSON only."""


def _model():
    return ChatGroq(
        model=GROQ_MODEL,
        api_key=groq_api_key("quotation"),
    ).with_structured_output(QuotationDecision)


def _is_malformed_tool_call(err: BaseException) -> bool:
    # Same Groq gpt-oss tool-calling flake documented in challenge.md —
    # observed here live for the first time (bogus tool name "json").
    # This was speculatively added once before and correctly removed for
    # not having been observed; it's back because it has now actually
    # happened, per that same rule.
    return isinstance(err, BadRequestError) and "tool_use_failed" in str(err)


@retry(
    retry=retry_if_exception(_is_malformed_tool_call),
    stop=stop_after_attempt(5),
    wait=wait_fixed(1),
    reraise=True,
)
async def _invoke(model, messages) -> QuotationDecision:
    return await model.ainvoke(messages)


async def quotation_agent(
    customer_name: str | None,
    product_name: str | None,
    quantity: int | None,
    price: float | None,
    stock_total: int,
    can_produce: bool,
    lead_time_days: int | None,
) -> QuotationResult:
    context = (
        f"customer_name: {customer_name}\n"
        f"product_name: {product_name}\n"
        f"quantity: {quantity}\n"
        f"catalog_price: {price}\n"
        f"stock_available: {stock_total}\n"
        f"can_produce: {can_produce}\n"
        f"lead_time_days: {lead_time_days}"
    )
    model = _model()
    messages = [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=context)]
    decision: QuotationDecision = await _invoke(model, messages)

    total_amount = (
        decision.quoted_price * quantity
        if decision.quoted_price is not None and quantity is not None
        else None
    )

    return QuotationResult(
        quoted_price=decision.quoted_price,
        quantity=quantity,
        total_amount=total_amount,
        valid_for_days=decision.valid_for_days,
        notes=decision.notes,
    )
