# app/schemas/service.py
from pydantic import BaseModel


class ServiceDecision(BaseModel):
    service_type: str  # e.g. "Installation", "Consulting", "Maintenance", "Repair", "Support" — free text, no rigid catalog exists for this yet
    scope_description: str  # what needs to be done, summarized from the request
    estimated_hours: int | None = None  # only if the customer actually stated an estimate — never guessed
