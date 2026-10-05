# app/agents/export_agent.py
from groq import BadRequestError
from langchain_groq import ChatGroq
from langchain_core.messages import SystemMessage, HumanMessage
from dotenv import load_dotenv
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_fixed

from app.config import GROQ_MODEL, groq_api_key
from app.schemas.export import ExportDecision

load_dotenv()


SYSTEM_PROMPT = """You are the export agent for an ERP sales system. A
customer is placing an international order that needs to ship across a
border, not a standard domestic order.

Extract:
- destination_country: the country the goods are being shipped to. Null
  if not stated — never guess one.
- incoterm: the shipping term if the customer stated one (e.g. FOB, CIF,
  EXW, DAP). Null if none was mentioned — never invent one.

Return valid JSON only."""


def _model():
    return ChatGroq(
        model=GROQ_MODEL,
        api_key=groq_api_key("export"),
    ).with_structured_output(ExportDecision)


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
async def _invoke(model, messages) -> ExportDecision:
    return await model.ainvoke(messages)


async def export_agent(user_message: str) -> ExportDecision:
    model = _model()
    messages = [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=user_message)]
    result: ExportDecision = await _invoke(model, messages)
    return result
