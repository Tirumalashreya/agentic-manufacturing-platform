# app/agents/scenario_comparison_agent.py
from groq import BadRequestError
from langchain_groq import ChatGroq
from langchain_core.messages import SystemMessage, HumanMessage
from dotenv import load_dotenv
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_fixed

from app.config import GROQ_MODEL, groq_api_key
from app.schemas.promise import ScenarioComparisonDecision

load_dotenv()


SYSTEM_PROMPT = """You are the recommendation step of a manufacturing
order-promise agent. You are given one or more already-simulated
scenarios for fulfilling a customer's delivery request — each one's
feasibility, quantities, and projected delivery date were computed
deterministically by the real scheduling/inventory systems, not by you.

Recommend the best scenario:
- Prefer a FEASIBLE scenario (feasible: true) that meets the requested
  delivery date over one that doesn't.
- Among feasible scenarios, prefer the one with fewer risk flags and less
  reliance on an external vendor, unless the facts given suggest
  otherwise.
- A scenario with feasible: null means its real outcome is only knowable
  by actually executing it — the deterministic system could not simulate
  it in advance. You may recommend such a scenario only when no scenario
  has feasible: true, and you must say explicitly in your reasoning that
  its outcome is not guaranteed and will only be known after it runs.
- feasible and promise_restored are NOT the same fact: feasible means the
  scheduler found a valid plan at all; promise_restored means that plan's
  own projected date still meets the ORIGINAL promised date. A scenario
  can be feasible: true and promise_restored: false at the same time —
  that is a real, different outcome from being infeasible, and your
  reasoning must say so plainly rather than calling it simply "feasible."
  When promise_restored is null, no original promise applies to this
  scenario (e.g. a fresh delivery request, not a recovery) — do not treat
  null as false.
- failure_reason, when present, is a real, already-computed explanation —
  you may quote or paraphrase it, but never contradict it.
- If NO scenario is feasible (true) AND NO scenario has an unknown
  (null) outcome either, say so plainly and return null for
  recommended_scenario_id — do not pick an infeasible one and call it
  recommended.

You must cite only the scenario_ids and facts given to you. Never invent
a number, a date, or a reason not present in the given scenarios.
Return valid JSON only."""


def _model():
    return ChatGroq(
        model=GROQ_MODEL,
        api_key=groq_api_key("scenario_comparison"),
    ).with_structured_output(ScenarioComparisonDecision)


def _is_malformed_tool_call(err: BaseException) -> bool:
    return isinstance(err, BadRequestError) and "tool_use_failed" in str(err)


@retry(
    retry=retry_if_exception(_is_malformed_tool_call),
    stop=stop_after_attempt(5),
    wait=wait_fixed(1),
    reraise=True,
)
async def _invoke(model, messages) -> ScenarioComparisonDecision:
    return await model.ainvoke(messages)


async def scenario_comparison_agent(scenarios: list[dict]) -> ScenarioComparisonDecision:
    scenario_lines = "\n\n".join(
        f"  scenario_id: {s['scenario_id']}\n"
        f"  label: {s['label']}\n"
        f"  feasible: {s['feasible']}\n"
        f"  quantity_from_stock: {s['quantity_from_stock']}\n"
        f"  quantity_to_make: {s['quantity_to_make']}\n"
        f"  quantity_from_vendor: {s['quantity_from_vendor']}\n"
        f"  requested_delivery_date: {s.get('requested_delivery_date')}\n"
        f"  projected_delivery_date: {s.get('projected_delivery_date')}\n"
        f"  promise_restored: {s.get('promise_restored')}\n"
        f"  failure_reason: {s.get('failure_reason')}\n"
        f"  production_status: {s.get('production_status')}\n"
        f"  risk_flags: {s.get('risk_flags')}"
        for s in scenarios
    )
    context = f"Simulated scenarios:\n\n{scenario_lines}"

    model = _model()
    messages = [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=context)]
    result: ScenarioComparisonDecision = await _invoke(model, messages)
    return result
