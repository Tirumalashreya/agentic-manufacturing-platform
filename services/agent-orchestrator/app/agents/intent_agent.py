import os
from langchain_groq import ChatGroq
from langchain_core.messages import SystemMessage, HumanMessage
from pydantic import BaseModel
from dotenv import load_dotenv
import os
from langchain_groq import ChatGroq
from langchain_core.messages import SystemMessage, HumanMessage
from pydantic import BaseModel
from dotenv import load_dotenv
from typing import Literal

from app.config import GROQ_MODEL

load_dotenv()


class IntentResult(BaseModel):
    intent: Literal["request_quote", "create_order", "return", "credit_memo"]
    customer: str | None = None
    product: str | None = None
    quantity: int | None = None
    requested_deadline: str | None = None
    needs_clarification: bool = False
    clarification_question: str | None = None


SYSTEM_PROMPT = """You are an intent and entity extraction agent for an ERP sales system.

Given the user's request, identify:

1. intent
2. customer
3. product
4. quantity
5. requested_deadline

Do not guess missing information.
Return null when information is not provided.
If essential information is missing, set needs_clarification=true
and generate one concise clarification question.

Return valid JSON only."""


def _model():
    return ChatGroq(
        model=GROQ_MODEL,
        api_key=os.environ["GROQ_API_KEY"],
    ).with_structured_output(IntentResult)


async def intent_agent(user_input: str) -> IntentResult:
    model = _model()
    messages = [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=user_input)]
    result: IntentResult = await model.ainvoke(messages)
    return result


from app.config import GROQ_MODEL

load_dotenv()


class IntentResult(BaseModel):
    intent: Literal["request_quote", "create_order", "return", "credit_memo"]
    customer: str | None = None
    product: str | None = None
    quantity: int | None = None
    requested_deadline: str | None = None
    needs_clarification: bool = False
    clarification_question: str | None = None


SYSTEM_PROMPT = """You are an intent and entity extraction agent for an ERP sales system.

Given the user's request, identify:

1. intent
2. customer
3. product
4. quantity
5. requested_deadline

Do not guess missing information.
Return null when information is not provided.
If essential information is missing, set needs_clarification=true
and generate one concise clarification question.

Return valid JSON only."""


def _model():
    return ChatGroq(
        model=GROQ_MODEL,
        api_key=os.environ["GROQ_API_KEY"],
    ).with_structured_output(IntentResult)


async def intent_agent(user_input: str) -> IntentResult:
    model = _model()
    messages = [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=user_input)]
    result: IntentResult = await model.ainvoke(messages)
    return result
