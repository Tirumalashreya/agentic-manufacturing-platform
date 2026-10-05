# app/tools/reference_resolution.py
"""
Step 2.2 of the dynamic-ERP roadmap (agreed with the user): connects
EntityReference (what request_understanding_agent extracts) to
entity_resolver.resolve_entity() (the deterministic identifier lookup).
Still no LLM call anywhere here, and still no query/retrieval logic for
temporal/relative references — this system genuinely has no "find the
most recent sales order for a customer" capability anywhere in tools/
today. This module is honest about that gap rather than faking it:
temporal/relative/ambiguous references resolve to UNSUPPORTED_REFERENCE
with a reason explaining exactly what's missing, never a guessed record.

Not wired into graph.py yet on purpose — that's the next step, once this
piece is itself tested and trusted on its own.
"""
from typing import Literal

from app.schemas.understanding import EntityReference
from app.tools.entity_resolver import KNOWN_ENTITY_TYPES, resolve_entity

ResolutionStatus = Literal["RESOLVED", "AMBIGUOUS", "NOT_FOUND", "UNSUPPORTED_REFERENCE"]

# identifier_types resolve_entity() can actually act on today — a direct
# name/id lookup. temporal/relative/ambiguous all need real query logic
# (e.g. "the most recent order for customer X") that doesn't exist
# anywhere in this codebase yet — see the module docstring.
_LOOKUP_IDENTIFIER_TYPES = ("explicit_name", "explicit_id")


def resolve_reference(reference: EntityReference) -> dict:
    if reference.identifier_type not in _LOOKUP_IDENTIFIER_TYPES:
        return {
            "status": "UNSUPPORTED_REFERENCE",
            "resolved_record": None,
            "reason": (
                f"'{reference.identifier_type}' references require query/retrieval logic "
                f"(e.g. finding the most recent record for a customer) that doesn't exist "
                f"in this system yet — only direct name/id references are resolvable today."
            ),
        }

    if reference.entity_type not in KNOWN_ENTITY_TYPES:
        return {
            "status": "UNSUPPORTED_REFERENCE",
            "resolved_record": None,
            "reason": f"No resolver registered for entity_type '{reference.entity_type}'.",
        }

    record = resolve_entity(reference.entity_type, reference.identifier)
    if record is None:
        return {
            "status": "NOT_FOUND",
            "resolved_record": None,
            "reason": f"No {reference.entity_type} found matching '{reference.identifier}'.",
        }

    # AMBIGUOUS is a real, reachable status in this contract, but not
    # producible today: every resolve_entity() lookup returns only the
    # first match, not the full candidate set, so there's no way yet to
    # detect "more than one real record matched". Exposing match counts
    # from the underlying find_*/get_* functions is a real, separate
    # change this step deliberately doesn't make speculatively.
    return {
        "status": "RESOLVED",
        "resolved_record": record,
        "reason": f"Matched {reference.entity_type} via {reference.identifier_type}.",
    }
