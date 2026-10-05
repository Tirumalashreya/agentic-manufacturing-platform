# app/agents/negotiation_agent.py
from groq import BadRequestError
from langchain_groq import ChatGroq
from langchain_core.messages import SystemMessage, HumanMessage
from dotenv import load_dotenv
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_fixed

from app.config import GROQ_MODEL, groq_api_key
from app.schemas.negotiation import NegotiationDecision

load_dotenv()


SYSTEM_PROMPT = """You are the negotiation agent for an ERP sales system.

A customer has an existing quotation and is now asking for a better price.
Read their message and extract what they are asking for:

- requested_discount_percent: fill this in if they name a percentage off
  (e.g. "10% off", "can you knock off 15%").
- requested_price: fill this in if they name a target unit price instead
  (e.g. "can you do it for 45000 each").

Fill in whichever ONE of these the message actually states. Leave the other
null — do not compute one from the other yourself, that conversion is done
deterministically elsewhere, not by you.

- summary: one concise sentence describing what the customer is asking for.

You are NOT deciding whether this discount is approved. Do not reason about
pricing authority, discount limits, or whether the request is "reasonable" —
that is a separate deterministic policy check, not your job. You only
interpret the request.

Return valid JSON only."""


def _model():
    return ChatGroq(
        model=GROQ_MODEL,
        api_key=groq_api_key("negotiation"),
    ).with_structured_output(NegotiationDecision)


def _is_malformed_tool_call(err: BaseException) -> bool:
    # Same Groq gpt-oss tool-calling flake documented in challenge.md —
    # observed here live for the first time (bogus tool name "json").
    return isinstance(err, BadRequestError) and "tool_use_failed" in str(err)


@retry(
    retry=retry_if_exception(_is_malformed_tool_call),
    stop=stop_after_attempt(5),
    wait=wait_fixed(1),
    reraise=True,
)
async def _invoke(model, messages) -> NegotiationDecision:
    return await model.ainvoke(messages)


async def negotiation_agent(negotiation_message: str) -> NegotiationDecision:
    model = _model()
    messages = [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=negotiation_message)]
    result: NegotiationDecision = await _invoke(model, messages)
    return result
