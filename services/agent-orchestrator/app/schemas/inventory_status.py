# app/schemas/inventory_status.py
from typing import Literal

from pydantic import BaseModel

# Mirrors ProductionPlanningDecision's established shape (Phase 8, agreed
# with the user): the agent reasons over an already-computed real shortage
# scan and only ever produces a verdict + a plain business explanation —
# never a quantity itself (that comes from inventory-service's own
# checkShortagesForProduct, untouched).
InventoryStatus = Literal["OK", "SHORTAGE"]


class InventoryStatusDecision(BaseModel):
    status: InventoryStatus
    explanation: str
