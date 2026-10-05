# app/agents/production_planning_agent.py
from groq import BadRequestError
from langchain_groq import ChatGroq
from langchain_core.messages import SystemMessage, HumanMessage
from dotenv import load_dotenv
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_fixed

from app.config import GROQ_MODEL, groq_api_key
from app.schemas.production_planning import ProductionPlanningDecision

load_dotenv()


SYSTEM_PROMPT = """You are the production planning agent for a
manufacturing ERP system. An order needs to be produced (MTO/CTO/HYBRID).
The materials check, the routing, and a real simulated production
schedule have already been computed deterministically by the actual
manufacturing services — you are NOT computing any of that yourself. You
are given the results and must synthesize them into one verdict and a
short, business-facing explanation a sales approver can read in a few
seconds.

Decide status:
- PASS: all materials available, the simulated schedule has every
  operation placed, and it finishes on or before the required date.
- WARNING: producible and on time, but with a real risk worth flagging
  (e.g. an operation only fit on an alternative machine/work center, or a
  conflict was detected and resolved).
- MATERIAL_SHORTAGE: one or more components are short. This takes
  priority over everything else — say plainly which component(s) and by
  how much, using the numbers given to you.

Note: whether every operation actually got placed (operations_not_placed)
is NOT your call to make — the calling service decides that deterministically
from the real scheduler's own result and overrides your status when it
disagrees with you, the same way it already does for MATERIAL_SHORTAGE.
If you're given a case where operations_not_placed > 0, just describe
honestly what the facts show (e.g. "the assembly step couldn't be scheduled
within the current window") — your STATUS field for that case will be
ignored either way, only your explanation is used.

Never invent a reason. Only state what the given facts actually show.
Give one or two concise sentences of explanation, plain business language,
no jargon, no chain-of-thought.
Return valid JSON only."""


def _model():
    return ChatGroq(
        model=GROQ_MODEL,
        api_key=groq_api_key("production_planning"),
    ).with_structured_output(ProductionPlanningDecision)


def _is_malformed_tool_call(err: BaseException) -> bool:
    return isinstance(err, BadRequestError) and "tool_use_failed" in str(err)


@retry(
    retry=retry_if_exception(_is_malformed_tool_call),
    stop=stop_after_attempt(5),
    wait=wait_fixed(1),
    reraise=True,
)
async def _invoke(model, messages) -> ProductionPlanningDecision:
    return await model.ainvoke(messages)


async def production_planning_agent(
    product_name: str | None,
    quantity: int,
    required_date: str | None,
    materials: list[dict],
    routing_operations: list[dict],
    simulated_operations: list[dict],
    scheduling_conflicts_detected: int,
) -> ProductionPlanningDecision:
    materials_lines = "\n".join(
        f"  - {m['component_name']}: required {m['required']}, available {m['available']}, "
        f"shortage {m['shortage']}"
        for m in materials
    ) or "  (no BOM data for this product)"
    routing_lines = "\n".join(
        f"  - {op['operation']} (work center {op['work_center_code']})" for op in routing_operations
    ) or "  (no routing data for this product)"
    schedule_lines = "\n".join(
        f"  - {op['operation']} on {op['machine_name']}: {op['scheduled_start']} - {op['scheduled_end']}"
        for op in simulated_operations
    ) or "  (no operations could be placed)"
    unplaced_count = len(routing_operations) - len(simulated_operations)

    context = (
        f"product_name: {product_name}\n"
        f"quantity: {quantity}\n"
        f"required_date: {required_date}\n"
        f"materials:\n{materials_lines}\n"
        f"routing_operations:\n{routing_lines}\n"
        f"simulated_schedule:\n{schedule_lines}\n"
        f"operations_not_placed: {unplaced_count}\n"
        f"scheduling_conflicts_detected: {scheduling_conflicts_detected}"
    )
    model = _model()
    messages = [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=context)]
    result: ProductionPlanningDecision = await _invoke(model, messages)
    return result
