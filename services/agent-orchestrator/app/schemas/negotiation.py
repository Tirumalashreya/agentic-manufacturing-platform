# app/schemas/negotiation.py
from pydantic import BaseModel


# What the LLM extracts from the customer's message — pure interpretation.
# No math (converting between percent and target price is deterministic)
# and no approval decision (that's the pricing policy tool's job, not the
# model's memory of what a "reasonable" discount is).
class NegotiationDecision(BaseModel):
    requested_discount_percent: float | None = None
    requested_price: float | None = None
    summary: str
