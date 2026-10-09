# app/schemas/disruption.py
"""Phase 11 (Promise Monitoring & Agentic Recovery).

The typed shape scheduling-service's checkPromiseImpact (src/index.ts)
sends over HTTP once it has ALREADY determined, deterministically, that a
real customer promise was breached by a disruption. Everything in this
event is a plain fact scheduling-service's own Postgres data already
supplied — no field here is ever filled in by an LLM."""
from pydantic import BaseModel


class DisruptionEvent(BaseModel):
    event_id: str
    trace_id: str
    disruption_type: str
    plant_id: str
    affected_resource_id: str | None = None
    production_order_id: str
    product_id: str
    customer_name: str | None = None
    requested_quantity: float
    requested_date: str
    original_promised_date: str
    current_promised_date: str | None = None
    occurred_at: str
