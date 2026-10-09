# app/agents/promise_options_agent.py
from groq import BadRequestError
from langchain_groq import ChatGroq
from langchain_core.messages import SystemMessage, HumanMessage
from dotenv import load_dotenv
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_fixed

from app.config import GROQ_MODEL, groq_api_key
from app.schemas.promise import PromiseOptionsDecision

load_dotenv()


SYSTEM_PROMPT = """You are the alternative-generation step of a
manufacturing order-promise agent. Given the real facts gathered so far
about a goal, decide which of these fixed, already-supported
alternatives are worth actually investigating.

For a fresh delivery-feasibility goal (goal_type ORDER_PROMISE, or no
goal_type given):
- STOCK_PLUS_PRODUCTION: ship what's in stock now, produce the rest.
- PRODUCTION_ONLY: produce the full quantity (ignore any partial stock).
- VENDOR: cover whatever stock doesn't via an external vendor.
- LATER_DATE: the same fulfillment approach, but against a later
  delivery date — only worth investigating if the requested date looks
  tight given what you've observed.

For a disruption-recovery goal (goal_type PROMISE_RECOVERY — a real
customer promise was already breached by a disruption, see the
`disruption`/`current_result` fields in the goal), the only two
supported alternatives are:
- RESCHEDULE_BOTTLENECK: attempt a bottleneck-mode replan of the
  directly-affected order cluster — always worth investigating when a
  promise has been breached, since it is the one real recovery action
  this system can take.
- KEEP_CURRENT: accept the disrupted schedule's new date as the new
  promise — always include this as the honest floor/fallback.

You are NOT deciding whether an alternative is feasible — that is
determined deterministically after you choose (and for
RESCHEDULE_BOTTLENECK specifically, its real outcome may not be knowable
without actually executing it — that is a fact the deterministic system
reports, not something you estimate).

Never invent an alternative outside the exact labels for the goal_type
you were given. Return valid JSON only."""


def _model():
    return ChatGroq(
        model=GROQ_MODEL,
        api_key=groq_api_key("promise_options"),
    ).with_structured_output(PromiseOptionsDecision)


def _is_malformed_tool_call(err: BaseException) -> bool:
    return isinstance(err, BadRequestError) and "tool_use_failed" in str(err)


@retry(
    retry=retry_if_exception(_is_malformed_tool_call),
    stop=stop_after_attempt(5),
    wait=wait_fixed(1),
    reraise=True,
)
async def _invoke(model, messages) -> PromiseOptionsDecision:
    return await model.ainvoke(messages)


async def promise_options_agent(goal: dict, observations: dict) -> PromiseOptionsDecision:
    goal_lines = "\n".join(f"  {k}: {v}" for k, v in goal.items() if v is not None)
    observed_lines = "\n".join(
        f"  - {name}: {result.get('data') or result.get('errors')}" for name, result in observations.items()
    ) or "  (no observations)"
    context = f"Goal:\n{goal_lines}\n\nObserved facts:\n{observed_lines}"

    model = _model()
    messages = [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=context)]
    result: PromiseOptionsDecision = await _invoke(model, messages)
    return result
