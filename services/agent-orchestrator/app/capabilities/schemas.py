# app/capabilities/schemas.py
"""Phase 10 (Agentic Order Promise & Scenario Reasoning).

Typed contracts for the bounded capability registry. The LLM reasoning
loop never sees raw Python objects, database rows, or arbitrary dicts —
only these normalized shapes. A CapabilityResult's `data` is always a
compact, already-computed set of facts; the LLM reasons over `data`, it
never recomputes it.
"""
from typing import Any, Literal

from pydantic import BaseModel, Field

ReadWrite = Literal["read", "read_with_side_effect", "none"]

# "investigate" — offered to the capability-selector loop (info gathering).
# "compose" — reasoning/composition steps, invoked by orchestration code at
#   a fixed point in the pipeline, never offered to the capability-selector
#   loop as a "next step" choice.
# "consequential" — a real domain mutation. Never callable by ANY LLM-driven
#   dispatch — only orchestration code calls these, and only after the
#   existing Stage 04 approval machinery has recorded a real human decision.
CapabilityPhase = Literal["investigate", "compose", "consequential"]


class CapabilitySpec(BaseModel):
    name: str
    description: str
    read_write: ReadWrite
    authoritative_source: str
    timeout_seconds: float
    phase: CapabilityPhase
    # Hard security boundary (brief §14) — belt-and-suspenders alongside
    # phase == "consequential": even if a future phase value is added
    # carelessly, consequential=True alone still blocks LLM-driven dispatch.
    consequential: bool = False


class CapabilityCall(BaseModel):
    capability: str
    # Deliberately NOT filled in by the LLM for "investigate" capabilities —
    # the reasoning loop only lets the model choose WHICH capability, then
    # graph.py's own deterministic code fills in arguments from already-
    # resolved state (product_id, customer_name, plant_id, ...). See
    # graph.py's promise_reasoning_node::_args_for. This field exists so the
    # typed contract is uniform and so a future compose-phase capability
    # that genuinely needs model-supplied arguments has somewhere typed to
    # put them — not so today's investigate capabilities can be handed
    # arbitrary LLM-authored values.
    arguments: dict[str, Any] = Field(default_factory=dict)
    reason: str


class CapabilityResult(BaseModel):
    capability: str
    success: bool
    data: dict[str, Any] = Field(default_factory=dict)
    authoritative_source: str
    errors: dict[str, Any] | None = None


# A typed internal representation of one candidate way to fulfill the
# promise. Every field here must come from a real capability result or
# simple arithmetic already established elsewhere in this codebase
# (compute_fulfillment_split's own min/subtract pattern) — never invented.
# Fields the current system genuinely cannot compute (cost, expedite
# premium) are simply absent, per the brief's own instruction not to
# fabricate a metric that doesn't exist.
class PromiseScenario(BaseModel):
    scenario_id: str
    label: str
    quantity_from_stock: int = 0
    quantity_to_make: int = 0
    quantity_from_vendor: int = 0
    requested_delivery_date: str | None = None
    projected_delivery_date: str | None = None
    # Phase 11: None is a real, distinct, honest value — not "unknown
    # defaulting to False." It means the real deterministic system has no
    # non-committing way to simulate this option (e.g. a BOTTLENECK-mode
    # reschedule of an already-disrupted order — scheduling-service has no
    # dry-run for that), so its true outcome is only knowable by actually
    # executing it. Never set to True/False by the LLM — only by a real
    # simulation call, or left None when no such call exists.
    feasible: bool | None
    production_status: str | None = None
    risk_flags: list[str] = Field(default_factory=list)
    evidence: dict[str, Any] = Field(default_factory=dict)
    assumptions: list[str] = Field(default_factory=list)
    # Internal bookkeeping, not shown to the LLM comparison step directly —
    # a non-chosen scenario's draft ProductionOrder must be cleaned up
    # (same principle as resolve_sales_order_approval's REJECTED cleanup).
    production_order_id: str | None = None
    # Phase 13 — distinct from `feasible` on purpose: a reschedule can be
    # FEASIBLE (the scheduler successfully placed every operation
    # somewhere) while still landing AFTER the original promise, which is
    # a real, different outcome from one that actually restores it.
    # feasible answers "did the scheduler find a valid plan at all";
    # promise_restored answers "does that plan still meet what was
    # promised." Only ever set by deterministic code (the what-if date
    # compared against the original promise), never by the LLM — None
    # when there's no original promise to restore (every Phase 10
    # ORDER_PROMISE scenario) or no real simulation exists for this
    # scenario at all.
    promise_restored: bool | None = None
    # A short, deterministic, human-readable reason set only when
    # feasible is False or promise_restored is False — never fabricated
    # LLM prose; built directly from the same real numbers evidence holds.
    failure_reason: str | None = None
