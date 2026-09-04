# app/agents/subscription_agent.py
from groq import BadRequestError
from langchain_groq import ChatGroq
from langchain_core.messages import SystemMessage, HumanMessage
from dotenv import load_dotenv
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_fixed

from app.config import GROQ_MODEL, groq_api_key
from app.schemas.subscription import SubscriptionDecision

load_dotenv()


SYSTEM_PROMPT = """You are the subscription agent for an ERP sales system.
A customer wants to sign up for or renew a recurring plan.

Extract:
- action: NEW if this is a first-time signup, RENEWAL if they're
  continuing/renewing/extending something already in place (look for
  words like "renew", "continue", "extend", or "our" implying an
  existing plan), CANCEL if they want to stop/end/terminate an existing
  plan (look for words like "cancel", "stop", "terminate", "end").
- requested_plan_name: the plan name exactly as the customer described it
  (e.g. "annual software subscription", "Gold plan", "cloud hosting").
  Do not invent a plan name they didn't state.

You are NOT deciding which real plan this matches or its price — that is
looked up deterministically elsewhere, not by you.

Return valid JSON only."""


def _model():
    return ChatGroq(
        model=GROQ_MODEL,
        api_key=groq_api_key("subscription"),
    ).with_structured_output(SubscriptionDecision)


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
async def _invoke(model, messages) -> SubscriptionDecision:
    return await model.ainvoke(messages)


async def subscription_agent(user_message: str) -> SubscriptionDecision:
    model = _model()
    messages = [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=user_message)]
    result: SubscriptionDecision = await _invoke(model, messages)
    return result
