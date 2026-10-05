# app/schemas/state.py
from typing import TypedDict, Any


class SalesState(TypedDict, total=False):
    user_message: str

    # Intent Agent output
    intent: str
    intent_confidence: float

    customer: str | None
    product: str | None
    quantity: int | None
    requested_deadline: str | None

    needs_clarification: bool
    clarification_question: str | None

    # Request Understanding Agent output (Phase 1 of the dynamic-ERP
    # roadmap) — additive, runs alongside Intent/Process, not instead of
    # them. See app/schemas/understanding.py for why these fields are
    # scoped this narrowly.
    request_goal: str
    request_constraints: list[str]
    request_actions: list[str]
    mentions_product_or_service: bool
    mentions_financial_adjustment: bool
    is_supported: bool
    # Phase 2 step 1 (agreed with the user): captured for visibility
    # (trace page, direct inspection) only — nothing in the graph routes
    # on this yet. Each dict mirrors EntityReference
    # (entity_type/identifier_type/identifier).
    request_references: list[dict]

    # Phase 2 step 2.3: structured multi-action/dependency representation
    # (see RequestedAction) — visibility only, same as request_references.
    # Nothing executes this; no LLM is allowed to run a sequence from it.
    request_action_plan: list[dict]

    # Phase 2 step 2.2/2.2b: each request_references entry run through
    # resolve_reference() — real record for explicit name/id references
    # that exist, honest UNSUPPORTED_REFERENCE for temporal/relative/
    # ambiguous ones (no query/retrieval logic exists for those yet).
    # Additive only: no existing routing/workflow reads this field, and
    # an unresolved reference does NOT trigger clarification — that
    # would be a real behavior change needing its own evidence first.
    resolved_references: list[dict]

    # Context Agent output
    customer_id: str | None
    customer_name: str | None
    customer_exists: bool
    customer_active: bool

    product_id: str | None
    product_name: str | None
    product_valid: bool

    price: float | None
    stock: list[dict[str, Any]]

    can_produce: bool
    product_configurable: bool
    lead_time_days: int | None
    customer_credit_limit: float | None

    # Process Decision Agent output
    entry_type: str
    process: str
    starting_stage: str
    process_reasoning: str

    # Quotation Agent output (Pre-Sales workflow)
    quoted_price: float | None
    quotation_total: float | None
    quotation_valid_days: int
    quotation_notes: str

    # create_quotation() tool output — the persisted transaction, if any
    quotation_id: str | None
    quotation_status: str

    # create_sales_order() tool output (Direct Sales workflow)
    sales_order_id: str | None
    sales_order_status: str
    sales_order_total: float | None

    # check_credit() tool output
    credit_checked: bool
    credit_within_limit: bool
    credit_existing_exposure: float
    credit_total_exposure: float

    # Composed-execution's check_stock action (plan_executor.py) — a
    # real bug found live: these three were never declared here, and
    # LangGraph silently drops any key a node returns that isn't part of
    # the declared state schema, so they were vanishing from every
    # response despite the Python code setting them correctly.
    stock_checked: bool
    stock_sufficient: bool
    stock_total: int

    # Fulfillment Decision Agent + compute_fulfillment_split() output
    fulfillment_strategy: str
    fulfillment_reasoning: str
    fulfillment_from_stock: int
    fulfillment_to_produce: int

    # Order-to-production Phase 1: the real Postgres SalesOrder.id and its
    # FulfillmentLine ids (keyed by sourceType: "STOCK"/"PRODUCTION"/"VENDOR"),
    # set by the dual-write in run_post_approval_fulfillment. Both are
    # best-effort — absent (None) if the dual-write wasn't reached or failed;
    # the real mock-ERP order this state is built from is never affected
    # either way.
    real_sales_order_id: str | None
    fulfillment_line_ids: dict[str, str]

    # Configuration Agent output (CTO path only)
    configuration_options: list[dict[str, Any]]

    # Production Planning Agent output (composed-execution/gated path only,
    # MTO/CTO/HYBRID's production leg) — the real materials/routing/
    # simulated-schedule plan from app/integrations/manufacturing_services.py,
    # computed pre-approval and echoed through pending_approval.context so
    # post-approval execution replays it rather than re-deciding. See
    # graph.py's _plan_production_via_manufacturing_services.
    production_plan: dict[str, Any]

    # Vendor-sourcing pre-decision (composed-execution/gated path only,
    # THIRD_PARTY/TRADING) — see graph.py's _plan_vendor_sourcing.
    vendor_plan: dict[str, Any]

    # Delivery/Billing (added alongside Delivery + Billing build)
    delivery_id: str | None
    delivery_status: str
    # Real SD-style delivery scheduling (agreed with the user): even a
    # fully in-stock order gets a real confirmed delivery date, not an
    # instant ship. See delivery_tools.compute_confirmed_delivery_date.
    confirmed_delivery_date: str | None
    invoice_id: str | None
    invoice_status: str
    invoice_amount: float | None

    # Post-Sales workflow output
    return_id: str | None
    credit_memo_id: str | None
    debit_memo_id: str | None

    # Service workflow output
    service_order_id: str | None

    # Subscription workflow output
    subscription_id: str | None

    # Project workflow output
    project_id: str | None

    # Export workflow output
    export_order_id: str | None

    # Consignment workflow output
    consignment_id: str | None

    # Financial workflow output
    financial_adjustment_id: str | None

    # Workflow
    current_stage: str

    # Composed-execution human-approval gate — see plan_executor.py's
    # GATE_BEFORE and graph.py's composed_execution_node.
    pending_approval: dict

    plan: list[dict[str, Any]]

    status: str
    response: str
