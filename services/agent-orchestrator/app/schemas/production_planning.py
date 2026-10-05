# app/schemas/production_planning.py
from typing import Literal

from pydantic import BaseModel

# Mirrors this system's existing pattern (see FulfillmentDecision): the
# agent reasons over already-computed deterministic facts (materials
# breakdown, routing operations, the real simulated schedule) and only
# ever produces a verdict + a plain business explanation — never a number,
# never a date, never a shortage quantity itself.
ProductionPlanningStatus = Literal["PASS", "WARNING", "MATERIAL_SHORTAGE", "UNPLANNABLE"]


class ProductionPlanningDecision(BaseModel):
    status: ProductionPlanningStatus
    explanation: str
