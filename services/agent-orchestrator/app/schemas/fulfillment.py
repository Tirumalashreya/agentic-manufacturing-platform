# app/schemas/fulfillment.py
from typing import Literal

from pydantic import BaseModel

FulfillmentStrategy = Literal[
    "MTS",
    "MTO",
    "CTO",
    "THIRD_PARTY",
    "INTERCOMPANY",
    "HYBRID",
]


# The agent decides the strategy only — not the numeric stock/production
# split for HYBRID. That's pure arithmetic (min(stock, quantity) etc.),
# computed deterministically by a tool in the next step, not by the model.
class FulfillmentDecision(BaseModel):
    strategy: FulfillmentStrategy
    reasoning: str
