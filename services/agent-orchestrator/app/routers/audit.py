# app/routers/audit.py
from fastapi import APIRouter

from app.tools.audit_tools import list_recent_audit_events

router = APIRouter(prefix="/audit")


@router.get("/events")
async def recent_events(limit: int = 100):
    return {"items": list_recent_audit_events(limit=limit)}
