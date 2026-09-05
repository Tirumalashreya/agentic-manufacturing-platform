# app/agents/procurement_agent.py
from groq import BadRequestError
from langchain_groq import ChatGroq
from langchain_core.messages import SystemMessage, HumanMessage
from dotenv import load_dotenv
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_fixed

from app.config import GROQ_MODEL, groq_api_key
from app.schemas.procurement import ProcurementDecision

load_dotenv()


SYSTEM_PROMPT = """You are the procurement agent for an ERP manufacturing
system. A production order has a real material shortage. For each short
component you are given the real vendors available for it (vendor_id,
lead_time_days, unit_cost) and the production order's target completion
date. Decide which vendor to use for each shortage:

- If only one vendor supplies a component, choose that one — there is no
  real decision to make.
- If multiple vendors supply it, weigh lead time against cost: prefer the
  cheaper/slower vendor as long as its lead time still comfortably beats
  the target completion date; switch to the faster/more expensive vendor
  only if the cheaper one would not arrive in time.

For each choice, give one concise sentence of reasoning that names the
actual lead-time/cost tradeoff you made (or says there was only one
option).

Return valid JSON only."""


def _model():
    return ChatGroq(
        model=GROQ_MODEL,
        api_key=groq_api_key("procurement"),
    ).with_structured_output(ProcurementDecision)


def _is_malformed_tool_call(err: BaseException) -> bool:
    # Same Groq gpt-oss tool-calling flake documented in challenge.md —
    # observed here live for the first time (bogus tool name "json").
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
async def _invoke(model, messages) -> ProcurementDecision:
    return await model.ainvoke(messages)


async def procurement_agent(shortages: list[dict], target_completion_date: str) -> ProcurementDecision:
    lines = [f"target_completion_date: {target_completion_date}", "shortages:"]
    for s in shortages:
        lines.append(
            f"- component_id={s['component_id']} component_name={s['component_name']} "
            f"shortage_qty={s['shortage']} vendors={s['vendors']}"
        )
    context = "\n".join(lines)
    model = _model()
    messages = [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=context)]
    result: ProcurementDecision = await _invoke(model, messages)
    return result
