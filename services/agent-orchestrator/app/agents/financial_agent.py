# app/agents/financial_agent.py
from groq import BadRequestError
from langchain_groq import ChatGroq
from langchain_core.messages import SystemMessage, HumanMessage
from dotenv import load_dotenv
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_fixed

from app.config import GROQ_MODEL, groq_api_key
from app.schemas.financial import FinancialDecision

load_dotenv()


SYSTEM_PROMPT = """You are the financial agent for an ERP sales system. A
customer is asking for a standalone financial adjustment to their account
— not tied to any specific order or product (that case is handled
elsewhere, as a Post-Sales return/credit).

Extract:
- adjustment_type: CREDIT_MEMO (a credit in the customer's favor),
  DEBIT_MEMO (a charge against the customer), or ADJUSTMENT (anything
  else, e.g. a correction) — map the request to the closest of these
  three.
- amount: only if the customer actually stated a real number. Null if no
  amount was mentioned — never guess or estimate one. You are transcribing
  a stated figure, not computing or inventing one.
- reference: an account/invoice number if one was mentioned. Null if none
  was given — this is often not tied to any specific reference at all.
- reason: one concise sentence summarizing why, in your own words.

Return valid JSON only."""


def _model():
    return ChatGroq(
        model=GROQ_MODEL,
        api_key=groq_api_key("financial"),
    ).with_structured_output(FinancialDecision)


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
async def _invoke(model, messages) -> FinancialDecision:
    return await model.ainvoke(messages)


async def financial_agent(user_message: str) -> FinancialDecision:
    model = _model()
    messages = [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=user_message)]
    result: FinancialDecision = await _invoke(model, messages)
    return result
