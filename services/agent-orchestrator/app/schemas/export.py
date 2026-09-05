# app/schemas/export.py
from pydantic import BaseModel


class ExportDecision(BaseModel):
    destination_country: str | None = None  # null if not stated — never invented; create_export_order rejects a missing one
    incoterm: str | None = None  # e.g. "FOB", "CIF", "EXW", "DAP" — free text, no rigid catalog; null if not stated
