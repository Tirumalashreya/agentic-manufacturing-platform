# app/schemas/procurement.py
from pydantic import BaseModel, Field


class VendorChoice(BaseModel):
    component_id: str
    vendor_id: str
    reasoning: str


class ProcurementDecision(BaseModel):
    choices: list[VendorChoice] = Field(default_factory=list)
    notes: str
