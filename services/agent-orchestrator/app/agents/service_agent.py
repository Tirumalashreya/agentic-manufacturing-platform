# app/agents/service_agent.py
from groq import BadRequestError
from langchain_groq import ChatGroq
from langchain_core.messages import SystemMessage, HumanMessage
from dotenv import load_dotenv
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_fixed

from app.config import GROQ_MODEL, groq_api_key
from app.schemas.service import ServiceDecision

load_dotenv()


SYSTEM_PROMPT = """You are the service agent for an ERP sales system. A
customer is requesting a service engagement rather than buying a physical
product — installation, consulting, maintenance, repair, or support.

Extract:
- service_type: a short label for the kind of service (Installation,
  Consulting, Maintenance, Repair, Support, or another concise label if
  none of those fit). There is no fixed catalog — pick the closest real
  description of what they're asking for.
- scope_description: one or two sentences summarizing exactly what work
  they want done, in your own words. Do not invent details they didn't
  state — if they were vague, keep the summary equally vague rather than
  making up specifics.
- estimated_hours: only if the customer actually stated a number of hours
  or days (convert days to hours at 8/day) of expected work. Null if no
  duration was mentioned — never guess one. This only matters for
  hourly-billed services; leave it null for a fixed-fee engagement like a
  one-off installation unless they specifically stated hours.

Return valid JSON only."""


def _model():
    return ChatGroq(
        model=GROQ_MODEL,
        api_key=groq_api_key("service"),
    ).with_structured_output(ServiceDecision)


def _is_malformed_tool_call(err: BaseException) -> bool:
    # Same Groq gpt-oss tool-calling flake documented in challenge.md —
    # observed here live for the first time as a new variant ("Tool
    # choice is required, but model did not call a tool" rather than a
    # bogus tool name), same underlying tool_use_failed code.
    return isinstance(err, BadRequestError) and "tool_use_failed" in str(err)


@retry(
    retry=retry_if_exception(_is_malformed_tool_call),
    stop=stop_after_attempt(5),
    wait=wait_fixed(1),
    reraise=True,
)
async def _invoke(model, messages) -> ServiceDecision:
    return await model.ainvoke(messages)


async def service_agent(user_message: str) -> ServiceDecision:
    model = _model()
    messages = [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=user_message)]
    result: ServiceDecision = await _invoke(model, messages)
    return result
