# app/routers/reconciliation.py
"""Phase 2: operator-facing Excel <-> Postgres reconciliation for Delivery,
Invoice, SalesOrder and Customer. Plain `def` routes on purpose — the
reconciler does blocking file I/O and synchronous HTTP, so FastAPI runs them
in its threadpool instead of stalling the event loop.

Repair direction:
  excel_to_postgres  (default; legacy, Excel is the first writer)
  postgres_to_excel  (Postgres authoritative; Excel is a projection). Because
      this writes rows into the Excel workbook, it REQUIRES an explicit `ids`
      allowlist — a blanket projection would copy every stale Postgres row
      (including test leftovers) into Excel."""
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.security import require_role
from app.tools.reconciliation_tools import reconcile_orders, reconcile_post_sales

router = APIRouter(prefix="/reconciliation", dependencies=[Depends(require_role("ADMIN"))])

_DIRECTIONS = ("excel_to_postgres", "postgres_to_excel")


class RepairBody(BaseModel):
    direction: str = "excel_to_postgres"
    ids: list[str] | None = None


def _check(direction: str, ids: list[str] | None) -> set[str] | None:
    if direction not in _DIRECTIONS:
        raise HTTPException(status_code=400, detail=f"direction must be one of {_DIRECTIONS}")
    if direction == "postgres_to_excel" and not ids:
        raise HTTPException(status_code=400, detail="postgres_to_excel repair requires an explicit non-empty `ids` list")
    return set(ids) if ids else None


@router.get("/post-sales")
def report(direction: str = Query("excel_to_postgres")):
    """Read-only drift report (Delivery, Invoice). Mutates nothing."""
    _check(direction, ["x"])
    return reconcile_post_sales(repair=False, direction=direction)


@router.post("/post-sales/repair")
def repair(body: RepairBody | None = None):
    """Repair Delivery/Invoice drift. Safe to repeat."""
    body = body or RepairBody()
    only = _check(body.direction, body.ids)
    return reconcile_post_sales(repair=True, direction=body.direction, only_ids=only)


@router.get("/orders")
def orders_report(direction: str = Query("excel_to_postgres")):
    """Read-only drift report (Customer, SalesOrder). Mutates nothing."""
    _check(direction, ["x"])
    return reconcile_orders(repair=False, direction=direction)


@router.post("/orders/repair")
def orders_repair(body: RepairBody | None = None):
    """Repair Customer/SalesOrder drift. Safe to repeat."""
    body = body or RepairBody()
    only = _check(body.direction, body.ids)
    return reconcile_orders(repair=True, direction=body.direction, only_ids=only)
