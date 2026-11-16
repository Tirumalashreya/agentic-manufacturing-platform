# app/agents/procurement_agent.py
from groq import BadRequestError
from langchain_groq import ChatGroq
from langchain_core.messages import SystemMessage, HumanMessage
from dotenv import load_dotenv
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_fixed

from app.config import GROQ_MODEL, groq_api_key
from app.schemas.procurement import ProcurementDecision, VendorChoice
from app.tools.procurement_tools import select_optimal_vendor

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
    # Deterministic baseline ranking for each shortage
    optimal_map = {}
    lines = [f"target_completion_date: {target_completion_date}", "shortages:"]
    for s in shortages:
        cid = s["component_id"]
        vendors = s.get("vendors", [])
        opt = select_optimal_vendor(vendors, target_completion_date)
        optimal_map[cid] = opt
        opt_str = f"recommended_vendor={opt['vendor_id']}" if opt else "no_vendor"
        lines.append(
            f"- component_id={cid} component_name={s['component_name']} "
            f"shortage_qty={s['shortage']} vendors={vendors} ({opt_str})"
        )
    context = "\n".join(lines)

    try:
        model = _model()
        messages = [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=context)]
        result: ProcurementDecision = await _invoke(model, messages)
        # Clamp choices to ensure valid vendors are selected
        for choice in result.choices:
            opt = optimal_map.get(choice.component_id)
            if opt and not any(v.get("vendor_id") == choice.vendor_id for v in next((s.get("vendors", []) for s in shortages if s["component_id"] == choice.component_id), [])):
                choice.vendor_id = opt["vendor_id"]
                choice.reasoning += f" (Clamped to optimal vendor {opt['vendor_id']})"
        return result
    except Exception as exc:
        fallback_choices = []
        for s in shortages:
            cid = s["component_id"]
            opt = optimal_map.get(cid)
            if opt:
                fallback_choices.append(VendorChoice(
                    component_id=cid,
                    vendor_id=opt["vendor_id"],
                    reasoning=f"Selected {opt['vendor_name']} based on optimal lead-time ({opt['lead_time_days']}d) and cost (${opt['unit_cost']})."
                ))
        return ProcurementDecision(
            choices=fallback_choices,
            notes="Deterministically ranked vendors by cost and schedule feasibility."
        )
