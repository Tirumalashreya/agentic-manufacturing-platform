# app/agents/fulfillment_agent.py
from groq import BadRequestError
from langchain_groq import ChatGroq
from langchain_core.messages import SystemMessage, HumanMessage
from dotenv import load_dotenv
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_fixed

from app.config import GROQ_MODEL, groq_api_key
from app.schemas.fulfillment import FulfillmentDecision
from app.tools.fulfillment_tools import determine_fulfillment_strategy

load_dotenv()


SYSTEM_PROMPT = """You are the fulfillment decision agent for an ERP sales
system. A Sales Order exists. Given the product and what we know from the
ERP, decide HOW it should be fulfilled:

- MTS (Make to Stock): stock on hand fully covers the requested quantity.
  Ship from existing inventory, no production needed.
- MTO (Make to Order): stock on hand covers none of the request (zero, or
  the product isn't stocked), and the product can be produced. The whole
  order needs production.
- HYBRID: stock on hand covers PART of the request but not all of it, and
  the product can be produced. Part ships from stock, the rest is
  produced — the common real case when stock is only partial.
- CTO (Configure to Order): the product is configurable. A configurable
  product is normally built to the customer's specific configuration
  rather than shipped from generic stock, so prefer CTO over
  MTS/MTO/HYBRID whenever the product is configurable, regardless of
  stock on hand.
- THIRD_PARTY: stock cannot cover the request AND the product cannot be
  produced internally. It would need to be sourced from an external
  vendor. You have no vendor data available — only choose this when
  MTS/MTO/HYBRID/CTO are all clearly impossible (no stock, cannot
  produce).
- INTERCOMPANY: fulfilled by a different plant or group company. You have
  no data about other plants or companies available to you — do not
  choose this unless the input explicitly says so (it usually will not);
  prefer the other strategies.

You are deciding the STRATEGY only. You are NOT computing how many units
come from stock vs. production for a HYBRID order — that split is
computed deterministically elsewhere, not by you.

Give one or two concise sentences of reasoning.
Return valid JSON only."""


def _model():
    return ChatGroq(
        model=GROQ_MODEL,
        api_key=groq_api_key("fulfillment"),
    ).with_structured_output(FulfillmentDecision)


def _is_malformed_tool_call(err: BaseException) -> bool:
    # Same Groq gpt-oss tool-calling flake documented in challenge.md —
    # observed here live (bogus tool name "commentary" instead of "json",
    # same tool_use_failed root cause).
    return isinstance(err, BadRequestError) and "tool_use_failed" in str(err)


@retry(
    retry=retry_if_exception(_is_malformed_tool_call),
    stop=stop_after_attempt(5),
    wait=wait_fixed(1),
    reraise=True,
)
async def _invoke(model, messages) -> FulfillmentDecision:
    return await model.ainvoke(messages)


async def fulfillment_agent(
    product_name: str | None,
    quantity: int | None,
    stock_total: int,
    can_produce: bool,
    product_configurable: bool,
    lead_time_days: int | None,
) -> FulfillmentDecision:
    # 1. Compute authoritative deterministic strategy based on ground-truth inventory & capability
    deterministic_strategy = determine_fulfillment_strategy(
        product_configurable=product_configurable,
        quantity=quantity,
        stock_total=stock_total,
        can_produce=can_produce,
    )

    context = (
        f"product_name: {product_name}\n"
        f"quantity: {quantity}\n"
        f"stock_available: {stock_total}\n"
        f"can_produce: {can_produce}\n"
        f"product_configurable: {product_configurable}\n"
        f"lead_time_days: {lead_time_days}\n"
        f"recommended_strategy: {deterministic_strategy}"
    )

    try:
        model = _model()
        messages = [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=context)]
        result: FulfillmentDecision = await _invoke(model, messages)
        # Production clamp: the strategy is mathematically guaranteed by the deterministic rule,
        # while the agent contributes plain-language explanation and business context.
        result.strategy = deterministic_strategy
        return result
    except Exception as exc:
        # Resilient fallback: LLM outage or rate-limiting must never halt mission-critical fulfillment
        fallback_reasoning = (
            f"Fulfillment determined as {deterministic_strategy} based on inventory ({stock_total}), "
            f"order quantity ({quantity}), and production capability ({can_produce})."
        )
        return FulfillmentDecision(strategy=deterministic_strategy, reasoning=fallback_reasoning)
