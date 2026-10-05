# app/schemas/project.py
from pydantic import BaseModel


class ProjectDecision(BaseModel):
    project_type: str  # e.g. "Manufacturing", "Turnkey Installation", "Engineering" — free text, no rigid catalog exists for this yet
    scope_description: str  # what the engagement covers, summarized from the request
    contract_value: float | None = None  # only if the customer actually stated a contract/budget value — never invented; milestone amounts stay unset until a real value exists
