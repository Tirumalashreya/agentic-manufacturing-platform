# app/schemas/consignment.py
from pydantic import BaseModel


class ConsignmentDecision(BaseModel):
    notes: str  # one concise sentence summarizing the consignment agreement terms, in the customer's own words
