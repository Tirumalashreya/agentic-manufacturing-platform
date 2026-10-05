# app/agents/project_agent.py
from groq import BadRequestError
from langchain_groq import ChatGroq
from langchain_core.messages import SystemMessage, HumanMessage
from dotenv import load_dotenv
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_fixed

from app.config import GROQ_MODEL, groq_api_key
from app.schemas.project import ProjectDecision

load_dotenv()


SYSTEM_PROMPT = """You are the project agent for an ERP sales system. A
customer is describing a large, milestone-based engagement rather than a
standard one-off order — e.g. a turnkey installation, a large manufacturing
contract, or a multi-phase build.

Extract:
- project_type: a short label for the kind of project (Manufacturing,
  Turnkey Installation, Engineering, or another concise label if none of
  those fit). There is no fixed catalog — pick the closest real description.
- scope_description: one or two sentences summarizing exactly what the
  project covers, in your own words. Do not invent details they didn't
  state — if they were vague, keep the summary equally vague.
- contract_value: only if the customer actually stated a contract value,
  budget, or total price for the project. Null if no value was mentioned —
  never guess one. Milestone billing cannot happen until a real value
  exists, and that is expected and handled downstream, not something to
  work around here.

Return valid JSON only."""


def _model():
    return ChatGroq(
        model=GROQ_MODEL,
        api_key=groq_api_key("project"),
    ).with_structured_output(ProjectDecision)


def _is_malformed_tool_call(err: BaseException) -> bool:
    # Same Groq gpt-oss tool-calling flake documented in challenge.md —
    # observed here live for the first time (bogus tool name "JSON").
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
async def _invoke(model, messages) -> ProjectDecision:
    return await model.ainvoke(messages)


async def project_agent(user_message: str) -> ProjectDecision:
    model = _model()
    messages = [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=user_message)]
    result: ProjectDecision = await _invoke(model, messages)
    return result
