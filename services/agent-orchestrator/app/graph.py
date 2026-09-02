from langgraph.graph import StateGraph, START, END

from app.schemas.state import SalesState
from app.agents.intent_agent import intent_agent
from app.agents.context_agent import context_agent


async def intent_node(state: SalesState):
    result = await intent_agent(state["user_message"])

    return {
        "intent": result.intent,
        "customer": result.customer,
        "product": result.product,
        "quantity": result.quantity,
        "requested_deadline": result.requested_deadline,
        "needs_clarification": result.needs_clarification,
        "clarification_question": result.clarification_question,
    }


async def context_node(state: SalesState):
    result = await context_agent(state["customer"], state["product"])

    return {
        "customer_id": result.customer_id,
        "customer_name": result.customer_name,
        "customer_exists": result.customer_exists,
        "customer_active": result.customer_active,
        "product_id": result.product_id,
        "product_name": result.product_name,
        "product_valid": result.product_valid,
        "price": result.price,
        "stock": [s.model_dump() for s in result.stock],
        "can_produce": result.can_produce,
        "product_configurable": result.product_configurable,
        "lead_time_days": result.lead_time_days,
    }


builder = StateGraph(SalesState)

builder.add_node("intent", intent_node)
builder.add_node("context", context_node)

builder.add_edge(START, "intent")
builder.add_edge("intent", "context")
builder.add_edge("context", END)

graph = builder.compile()
