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

    # Fulfillment Decision Agent + compute_fulfillment_split() output
    fulfillment_strategy: str
    fulfillment_reasoning: str
    fulfillment_from_stock: int
    fulfillment_to_produce: int

    # Configuration Agent output (CTO path only)
    configuration_options: list[dict[str, Any]]

    # Delivery/Billing (added alongside Delivery + Billing build)
    delivery_id: str | None
    delivery_status: str
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

    plan: list[dict[str, Any]]

    status: str
    response: str
