# app/schemas/quotation.py
from pydantic import BaseModel


# What the LLM actually decides — judgment calls only. quantity is a
# passthrough of the input and total_amount is pure arithmetic, so neither
# is asked of the model; both are computed deterministically afterward.
class QuotationDecision(BaseModel):
    quoted_price: float | None = None
    valid_for_days: int
    notes: str


class QuotationResult(BaseModel):
    quoted_price: float | None = None
    quantity: int | None = None
    total_amount: float | None = None
    valid_for_days: int
    notes: str
