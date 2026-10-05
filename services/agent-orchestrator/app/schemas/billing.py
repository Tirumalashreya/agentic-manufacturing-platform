# app/schemas/billing.py
from pydantic import BaseModel


# Judgment only — payment terms and whether to note a partial delivery.
# The invoice amount itself is pure arithmetic, computed deterministically
# by create_invoice(), never by the model.
class BillingDecision(BaseModel):
    payment_terms_days: int
    notes: str
