# app/agents/capability_selector_agent.py
from groq import BadRequestError
from langchain_groq import ChatGroq
from langchain_core.messages import SystemMessage, HumanMessage
from dotenv import load_dotenv
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_fixed

from app.capabilities.schemas import CapabilitySpec
from app.config import GROQ_MODEL, groq_api_key
from app.schemas.promise import CapabilityDecision

load_dotenv()


SYSTEM_PROMPT = """You are the investigation-planning step of a
manufacturing order-promise agent. A customer has asked whether we can
deliver a quantity of a product by a requested date.

You are given:
- the goal (customer, product, quantity, requested date)
- a list of AUTHORIZED capabilities you may ask to be investigated next,
  each with a name and a description
- what has already been investigated and what it found

Decide ONE of:
- "call_capability": name EXACTLY ONE capability from the authorized list
  that would genuinely help assess this goal and hasn't been investigated
  yet. Give a short reason.
- "sufficient_information": you already have enough to assess
  feasibility and generate alternatives — stop investigating.
- "need_clarification": the goal itself is too ambiguous to investigate
  at all (this should be rare — most ambiguity is resolved before you are
  called). Give a clarification_question.

You may ONLY name a capability from the authorized list given to you —
never invent one, never name one already investigated. You do not compute
or guess any numbers yourself; you only decide what to look at next.
Return valid JSON only."""


def _model():
    return ChatGroq(
        model=GROQ_MODEL,
        api_key=groq_api_key("capability_selector"),
    ).with_structured_output(CapabilityDecision)


def _is_malformed_tool_call(err: BaseException) -> bool:
    return isinstance(err, BadRequestError) and "tool_use_failed" in str(err)


@retry(
    retry=retry_if_exception(_is_malformed_tool_call),
    stop=stop_after_attempt(5),
    wait=wait_fixed(1),
    reraise=True,
)
async def _invoke(model, messages) -> CapabilityDecision:
    return await model.ainvoke(messages)


async def capability_selector_agent(
    goal: dict, observations: dict, available: list[CapabilitySpec]
) -> CapabilityDecision:
    goal_lines = "\n".join(f"  {k}: {v}" for k, v in goal.items() if v is not None)
    available_lines = "\n".join(f"  - {spec.name}: {spec.description}" for spec in available)
    observed_lines = "\n".join(
        f"  - {name}: success={result.get('success')}, data={result.get('data')}, errors={result.get('errors')}"
        for name, result in observations.items()
    ) or "  (nothing investigated yet)"

    context = (
        f"Goal:\n{goal_lines}\n\n"
        f"Authorized capabilities not yet investigated:\n{available_lines or '  (none remaining)'}\n\n"
        f"Already investigated:\n{observed_lines}"
    )
    model = _model()
    messages = [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=context)]
    result: CapabilityDecision = await _invoke(model, messages)
    return result
