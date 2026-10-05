# app/schemas/post_sales.py
from typing import Literal

from pydantic import BaseModel

PostSalesAction = Literal["RETURN", "CREDIT_MEMO", "DEBIT_MEMO"]


class PostSalesDecision(BaseModel):
    action: PostSalesAction
    referenced_order_id: str | None = None
    reason: str
