# app/agents/post_sales_agent.py
from groq import BadRequestError
from langchain_groq import ChatGroq
from langchain_core.messages import SystemMessage, HumanMessage
from dotenv import load_dotenv
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_fixed

from app.config import GROQ_MODEL, groq_api_key
from app.schemas.post_sales import PostSalesDecision

load_dotenv()


SYSTEM_PROMPT = """You are the post-sales agent for an ERP sales system.

A customer has an existing order and is asking for a return, a credit
memo, or a debit memo. Given the process category already decided
upstream and their raw message, extract:

- action: RETURN (for PRODUCT_RETURN or REPLACEMENT), CREDIT_MEMO, or
  DEBIT_MEMO — map the given process to the closest of these three.
- referenced_order_id: the order/SO number they mentioned, exactly as
  stated (e.g. "SO123"). Null if none was mentioned — do not invent one.
- reason: one concise sentence summarizing why, in your own words.

Return valid JSON only."""


def _model():
    return ChatGroq(
        model=GROQ_MODEL,
        api_key=groq_api_key("post_sales"),
    ).with_structured_output(PostSalesDecision)


def _is_malformed_tool_call(err: BaseException) -> bool:
    # Same Groq gpt-oss tool-calling flake documented in challenge.md —
    # observed here live for the first time (bogus tool name "json").
    return isinstance(err, BadRequestError) and "tool_use_failed" in str(err)


@retry(
    retry=retry_if_exception(_is_malformed_tool_call),
    stop=stop_after_attempt(5),
    wait=wait_fixed(1),
    reraise=True,
)
async def _invoke(model, messages) -> PostSalesDecision:
    return await model.ainvoke(messages)


async def post_sales_agent(process: str, user_message: str) -> PostSalesDecision:
    context = f"process: {process}\ncustomer_message: {user_message}"
    model = _model()
    messages = [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=context)]
    result: PostSalesDecision = await _invoke(model, messages)
    return result
