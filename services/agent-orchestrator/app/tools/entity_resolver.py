# app/tools/entity_resolver.py
"""
Deterministic (no LLM) entity lookup, unified behind one dispatcher.

This is the piece a future Phase 2 ("can the system figure out which ERP
record an implicit reference like 'the order we placed last month'
means") will need to call once something upstream can extract a *type +
identifier* from free text. This module does NOT do that extraction — it
only answers "given a known entity_type and identifier, fetch the real
record" — the deterministic half of that future feature, built and
fully testable today without any LLM call.

Deliberately scoped to entities that already have a real find_*/get_*
function somewhere in tools/ — no new lookup logic invented here, just
one place that knows which function to call for which entity type.
"""
from app.tools.approval_tools import get_approval_request
from app.tools.billing_tools import find_invoice
from app.tools.consignment_tools import find_consignment
from app.tools.customer_tools import get_customer
from app.tools.export_tools import find_export_order
from app.tools.financial_tools import find_financial_adjustment
from app.tools.post_sales_tools import find_sales_order, get_post_sales_action
from app.tools.product_tools import get_product
from app.tools.project_tools import find_project
from app.tools.service_tools import find_service_order
from app.tools.trading_tools import find_trading_order

# entity_type -> lookup function. Every function here takes exactly one
# positional identifier and returns dict | None, so the dispatcher stays
# this simple — no per-entity special-casing.
_RESOLVERS = {
    "customer": get_customer,                          # identifier: customer_name
    "product": get_product,                             # identifier: product_name
    "sales_order": find_sales_order,                    # identifier: sales_order_id
    "export_order": find_export_order,                  # identifier: export_order_id
    "consignment": find_consignment,                    # identifier: consignment_id
    "project": find_project,                            # identifier: project_id
    "service_order": find_service_order,                # identifier: service_order_id
    "trading_order": find_trading_order,                # identifier: trading_order_id
    "financial_adjustment": find_financial_adjustment,  # identifier: financial_adjustment_id
    "post_sales_action": get_post_sales_action,         # identifier: post_sales_id
    "invoice": find_invoice,                            # identifier: invoice_id
    "approval_request": get_approval_request,           # identifier: approval_id
}

KNOWN_ENTITY_TYPES = tuple(_RESOLVERS.keys())

# Entity kinds a future caller might reasonably ask for but no real
# lookup exists yet (no find_quotation/find_delivery/find_subscription in
# this codebase today) — named honestly here rather than fabricated, so
# a future caller can tell "not supported yet" apart from "not found".
UNRESOLVABLE_ENTITY_TYPES = ("quotation", "delivery", "subscription")


def resolve_entity(entity_type: str, identifier: str | None) -> dict | None:
    if identifier is None:
        return None
    resolver = _RESOLVERS.get(entity_type)
    if resolver is None:
        return None
    return resolver(identifier)
