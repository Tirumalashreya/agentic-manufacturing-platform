# app/schemas/process.py
from typing import Literal

from pydantic import BaseModel

EntryType = Literal[
    "PRE_SALES",
    "DIRECT_SALES",
    "POST_SALES",
    "SUBSCRIPTION",
    "SERVICE",
    "PROJECT",
    "FINANCIAL",
]

ProcessType = Literal[
    "QUOTE_REQUEST",
    "NEW_SALES_ORDER",
    "PRODUCT_RETURN",
    "REPLACEMENT",
    "NEW_SUBSCRIPTION",
    "SUBSCRIPTION_RENEWAL",
    "SERVICE_REQUEST",
    "PROJECT_ORDER",
    "CREDIT_MEMO",
    "DEBIT_MEMO",
    "FINANCIAL_ADJUSTMENT",
]


class ProcessResult(BaseModel):
    entry_type: EntryType
    process: ProcessType
    starting_stage: str
    reasoning: str
