# app/agents/configuration_agent.py
from langchain_groq import ChatGroq
from langchain_core.messages import SystemMessage, HumanMessage
from dotenv import load_dotenv

from app.config import GROQ_MODEL, groq_api_key
from app.schemas.configuration import ConfigurationResult

load_dotenv()


SYSTEM_PROMPT = """You are the configuration agent for an ERP sales system.

A customer's order requires Configure-to-Order (CTO) — the product is
built to their specific configuration rather than shipped as a generic
unit. Read the customer's original request and extract ONLY the
configuration options they actually stated.

- options: a list of (attribute, value) pairs actually mentioned, e.g.
  RAM: "32GB", Storage: "1TB SSD", Processor: "i7". Use the customer's own
  wording for the value.
- notes: one concise sentence. If the customer stated no configuration
  details at all, say so plainly — do not invent options they never
  mentioned.

You are NOT deciding whether these options are actually available or
valid for this product — that is a separate deterministic check, not
built yet, not your job. You only extract what was said.

Return valid JSON only."""


def _model():
    return ChatGroq(
        model=GROQ_MODEL,
        api_key=groq_api_key("configuration"),
    ).with_structured_output(ConfigurationResult)


async def configuration_agent(product_name: str | None, user_message: str) -> ConfigurationResult:
    context = f"product_name: {product_name}\ncustomer_request: {user_message}"
    model = _model()
    messages = [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=context)]
    result: ConfigurationResult = await model.ainvoke(messages)
    return result
