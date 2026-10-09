# app/schemas/promise.py
"""Phase 10 — structured outputs for the three new bounded reasoning
steps. Same philosophy as FulfillmentDecision/ProductionPlanningDecision:
the model returns a verdict/choice from a fixed, small set of options plus
free-text reasoning — never a number, a date, or an identifier it could
have invented."""
from typing import Literal

from pydantic import BaseModel

# What the capability-selector loop may decide at each iteration. `capability`
# is a free string here only so Pydantic can parse it; graph.py's own
# dispatch path re-validates it against the actual authorized remaining set
# before ever calling registry.dispatch — the model naming an unknown or
# already-called capability is rejected there, not trusted here.
CapabilityDecisionAction = Literal["call_capability", "sufficient_information", "need_clarification"]


class CapabilityDecision(BaseModel):
    action: CapabilityDecisionAction
    capability: str | None = None
    reason: str
    clarification_question: str | None = None


# The bounded alternative shapes this codebase can actually simulate or
# evidence — fixed on purpose. The model picks WHICH of these are worth
# investigating for this goal; graph.py's deterministic code decides
# WHETHER each one is actually feasible (or, for RESCHEDULE_BOTTLENECK,
# reports honestly that feasibility isn't knowable without executing it).
# STOCK_PLUS_PRODUCTION/PRODUCTION_ONLY/VENDOR/LATER_DATE are Phase 10's
# original four (ORDER_PROMISE goals). KEEP_CURRENT/RESCHEDULE_BOTTLENECK
# are Phase 11 additions, only ever offered for PROMISE_RECOVERY goals —
# see promise_reasoning_node's goal_type branch.
PromiseAlternativeLabel = Literal[
    "STOCK_PLUS_PRODUCTION", "PRODUCTION_ONLY", "VENDOR", "LATER_DATE",
    "KEEP_CURRENT", "RESCHEDULE_BOTTLENECK",
]


class PromiseOptionsDecision(BaseModel):
    alternatives_to_investigate: list[PromiseAlternativeLabel]
    reasoning: str


class ScenarioComparisonDecision(BaseModel):
    # None is a real, legitimate answer — "no simulated scenario meets the
    # request" must stay representable, never silently coerced to the
    # first scenario in the list.
    recommended_scenario_id: str | None
    reasoning: str
