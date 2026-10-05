# app/agents/quality_agent.py
from groq import BadRequestError
from langchain_groq import ChatGroq
from langchain_core.messages import SystemMessage, HumanMessage
from dotenv import load_dotenv
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_fixed

from app.config import GROQ_MODEL, groq_api_key
from app.schemas.quality_status import QualityStatusDecision

load_dotenv()


SYSTEM_PROMPT = """You are the quality status agent for a manufacturing
ERP system. A real QC-hold check and a real recent-inspection list have
already been computed deterministically by the actual scheduling service —
you are NOT re-deriving any hold logic or inspection result yourself. You
are given the real results and must synthesize them into one verdict and a
short, business-facing explanation.

Decide status:
- HOLD: the given hold status says a real operation is currently blocked
  on a QC hold. Say plainly which predecessor is holding it.
- RECENT_FAIL: not currently on hold, but the most recent inspection(s)
  given to you include a real FAIL.
- CLEAR: not on hold, and no recent FAIL in the given inspections.

Never invent an inspection result or a hold reason not present in the
given facts. Give one or two concise sentences, plain business language,
no jargon, no chain-of-thought.
Return valid JSON only."""


def _model():
    return ChatGroq(
        model=GROQ_MODEL,
        api_key=groq_api_key("quality_status"),
    ).with_structured_output(QualityStatusDecision)


def _is_malformed_tool_call(err: BaseException) -> bool:
    return isinstance(err, BadRequestError) and "tool_use_failed" in str(err)


@retry(
    retry=retry_if_exception(_is_malformed_tool_call),
    stop=stop_after_attempt(5),
    wait=wait_fixed(1),
    reraise=True,
)
async def _invoke(model, messages) -> QualityStatusDecision:
    return await model.ainvoke(messages)


async def quality_agent(inspections: list[dict], hold_status: dict | None) -> QualityStatusDecision:
    inspection_lines = "\n".join(
        f"  - {i.get('operation') or 'operation'}: {i['result']} at {i['inspectedAt']}"
        for i in inspections
    ) or "  (no recent inspections)"
    hold_line = (
        f"blocked: {hold_status['blocked']}, reason: {hold_status.get('reason')}"
        if hold_status is not None
        else "hold status not requested for a specific operation"
    )

    context = f"recent_inspections:\n{inspection_lines}\nhold_status: {hold_line}"
    model = _model()
    messages = [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=context)]
    result: QualityStatusDecision = await _invoke(model, messages)
    return result
