# app/schemas/quality_status.py
from typing import Literal

from pydantic import BaseModel

# Mirrors ProductionPlanningDecision's established shape (Phase 8, agreed
# with the user). CLEAR/HOLD/RECENT_FAIL are the only states the real data
# this agent is handed can actually distinguish: a real QC-hold gate result
# (blocked or not) plus a real recent inspection list — never re-derived
# here (see quality_agent.py), only explained.
QualityStatus = Literal["CLEAR", "HOLD", "RECENT_FAIL"]


class QualityStatusDecision(BaseModel):
    status: QualityStatus
    explanation: str
