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

    # Workflow
    entry_type: str
    current_stage: str

    sales_process: str
    fulfillment_strategy: str

    plan: list[dict[str, Any]]

    status: str
    response: str
