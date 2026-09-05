# app/agents/consignment_agent.py
from langchain_groq import ChatGroq
from langchain_core.messages import SystemMessage, HumanMessage
from dotenv import load_dotenv

from app.config import GROQ_MODEL, groq_api_key
from app.schemas.consignment import ConsignmentDecision

load_dotenv()


SYSTEM_PROMPT = """You are the consignment agent for an ERP sales system.
Stock is being transferred to a customer (the consignee) who will hold and
sell it on our behalf — we do not invoice this stock now, only whatever
quantity they actually sell later.

Extract:
- notes: one concise sentence summarizing the consignment agreement terms
  in your own words (e.g. how long they can hold it, any sell-through
  expectations). Do not invent details they didn't state.

Return valid JSON only."""


def _model():
    return ChatGroq(
        model=GROQ_MODEL,
        api_key=groq_api_key("consignment"),
    ).with_structured_output(ConsignmentDecision)


async def consignment_agent(user_message: str) -> ConsignmentDecision:
    model = _model()
    messages = [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=user_message)]
    result: ConsignmentDecision = await model.ainvoke(messages)
    return result
