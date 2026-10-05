# app/agents/inventory_agent.py
from groq import BadRequestError
from langchain_groq import ChatGroq
from langchain_core.messages import SystemMessage, HumanMessage
from dotenv import load_dotenv
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_fixed

from app.config import GROQ_MODEL, groq_api_key
from app.schemas.inventory_status import InventoryStatusDecision

load_dotenv()


SYSTEM_PROMPT = """You are the inventory status agent for a manufacturing
ERP system. A real shortage scan has already been run deterministically by
the actual inventory service — you are NOT computing any shortage math
yourself. You are given the real results and must synthesize them into one
verdict and a short, business-facing explanation.

Decide status:
- OK: the shortage list given to you is empty. Say plainly that no
  shortages were found.
- SHORTAGE: one or more components are short. Name which component(s) and
  by how much, using only the numbers given to you.

Never invent a component, a quantity, or a reason not present in the given
facts. Give one or two concise sentences, plain business language, no
jargon, no chain-of-thought.
Return valid JSON only."""


def _model():
    return ChatGroq(
        model=GROQ_MODEL,
        api_key=groq_api_key("inventory_status"),
    ).with_structured_output(InventoryStatusDecision)


def _is_malformed_tool_call(err: BaseException) -> bool:
    return isinstance(err, BadRequestError) and "tool_use_failed" in str(err)


@retry(
    retry=retry_if_exception(_is_malformed_tool_call),
    stop=stop_after_attempt(5),
    wait=wait_fixed(1),
    reraise=True,
)
async def _invoke(model, messages) -> InventoryStatusDecision:
    return await model.ainvoke(messages)


async def inventory_agent(shortages: list[dict]) -> InventoryStatusDecision:
    shortage_lines = "\n".join(
        f"  - component {s['productId']}: required {s['required']}, available {s['available']}"
        for s in shortages
    ) or "  (no shortages)"

    context = f"shortages:\n{shortage_lines}"
    model = _model()
    messages = [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=context)]
    result: InventoryStatusDecision = await _invoke(model, messages)
    return result
