# app/schemas/subscription.py
from typing import Literal

from pydantic import BaseModel

SubscriptionAction = Literal["NEW", "RENEWAL", "CANCEL"]


class SubscriptionDecision(BaseModel):
    action: SubscriptionAction
    requested_plan_name: str  # the customer's own wording for the plan, matched deterministically against the real plan catalog elsewhere
