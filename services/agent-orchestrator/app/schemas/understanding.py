# app/schemas/understanding.py
from typing import Literal

from pydantic import BaseModel


# Step 1 of Phase 2 (agreed with the user): teach the understanding layer
# to recognize that a reference to an ERP entity exists in the request,
# WITHOUT resolving it. entity_type is deliberately a free string, not
# constrained to entity_resolver.KNOWN_ENTITY_TYPES — the model's job is
# to describe what kind of thing is being referred to (its own read of
# the text), not to already know which types this system can resolve;
# that's the resolver's problem, one step later, per the explicit
# "LLM decides what's being referred to, deterministic code decides which
# real record matches" boundary. Resolution itself (matching `identifier`
# against real records — including "which order is 'latest'") is
# deliberately NOT built yet; this schema only captures that a reference
# exists and how it was expressed.
class EntityReference(BaseModel):
    entity_type: str
    identifier_type: Literal["explicit_name", "explicit_id", "temporal", "relative", "ambiguous"]
    identifier: str


# Step 2.3 of the dynamic-ERP roadmap (agreed with the user): represent a
# multi-step or conditional request's structure — WITHOUT executing any
# of it. "action" is a free-text label (not a rigid enum, same "LLM
# describes, deterministic code decides" boundary as EntityReference's
# entity_type) so this schema doesn't need to anticipate every possible
# action up front. depends_on names other `action` labels from the same
# action_plan list that must happen first — this is a description of
# ordering/conditionality the customer stated, not a plan this system
# runs; nothing in graph.py reads or acts on it yet.
class RequestedAction(BaseModel):
    action: str
    depends_on: list[str] = []


# Phase 1 of the dynamic-ERP roadmap agreed with the user: a narrow,
# additive layer that runs alongside the existing Intent/Process agents,
# not a replacement for them. Its only job is to capture what the
# existing IntentResult schema throws away (constraints, explicit
# requested actions) and to give entry_router a real, narrow signal for
# one specific failure mode: process_agent forced into FINANCIAL just
# because product_valid was false, even when the request is plainly
# about acquiring/building something, not money. This is NOT a general
# "confidence score" — those two booleans are deliberately the only
# judgment asked of this agent, because that's the exact, demonstrated
# bug being fixed, not a speculative general-purpose gate.
class RequestUnderstanding(BaseModel):
    goal: str
    constraints: list[str] = []
    requested_actions: list[str] = []
    mentions_product_or_service: bool
    mentions_financial_adjustment: bool
    # True unless the goal is something this ERP has no real capability
    # for at all (financing/payment plans, legal advice, anything
    # unrelated to sales/fulfillment/service/post-sales operations) — NOT
    # false just because a specific product/customer wasn't recognized;
    # that's UNCLEAR (see entry_router's existing override), a different
    # outcome from UNSUPPORTED on purpose. Defaults True so a model that
    # omits the field (or one that's uncertain) doesn't get accidentally
    # rejected — false is a deliberate, positive claim, not a fallback.
    is_supported: bool = True
    references: list[EntityReference] = []
    # Empty unless the request genuinely describes more than one action
    # or a conditional relationship between actions (see RequestedAction)
    # — a plain single-action request ("order 10 mice") stays [] here,
    # same "empty unless actually stated" convention as constraints/
    # requested_actions above. Deliberately separate from
    # requested_actions (a flat list of mentioned actions, unchanged) —
    # this is the structured, dependency-aware view, only populated when
    # that structure is actually present in the request.
    action_plan: list[RequestedAction] = []
    reasoning: str
