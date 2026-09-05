# app/schemas/financial.py
from typing import Literal

from pydantic import BaseModel

FinancialAdjustmentType = Literal["CREDIT_MEMO", "DEBIT_MEMO", "ADJUSTMENT"]


class FinancialDecision(BaseModel):
    adjustment_type: FinancialAdjustmentType
    amount: float | None = None  # only if the customer actually stated one — never invented
    reference: str | None = None  # an account/invoice reference, if one was mentioned
    reason: str
