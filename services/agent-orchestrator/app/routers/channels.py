# app/routers/channels.py
from fastapi import APIRouter, Depends, HTTPException

from app.security import require_role
from app.tools.billing_tools import list_invoices, mark_invoice_paid
from app.tools.consignment_tools import list_consignments
from app.tools.export_tools import list_export_orders
from app.tools.post_sales_tools import list_post_sales_actions
from app.tools.project_tools import find_project_milestones, list_projects
from app.tools.sales_tools import list_sales_orders
from app.tools.service_tools import list_service_orders
from app.tools.trading_tools import list_trading_orders

router = APIRouter(prefix="/channels")


# One GET per business-flow channel view — each is the full history of the
# one table that IS that channel (see PLAN.md: Domestic Sales = SalesOrders,
# Export = ExportOrders, Trading = TradingOrders, etc.), not a filtered
# slice. Complements Active Workflows (open items only, across domains)
# rather than duplicating it.
@router.get("/domestic-sales")
async def domestic_sales():
    return {"items": list_sales_orders()}


@router.get("/export-sales")
async def export_sales():
    return {"items": list_export_orders()}


@router.get("/services-sales")
async def services_sales():
    return {"items": list_service_orders()}


@router.get("/returns")
async def returns():
    return {"items": list_post_sales_actions()}


@router.get("/consignment-sales")
async def consignment_sales():
    return {"items": list_consignments()}


@router.get("/project-sales")
async def project_sales():
    return {"items": list_projects()}


@router.get("/project-sales/{project_id}/milestones")
async def project_milestones(project_id: str):
    return {"items": find_project_milestones(project_id)}


@router.get("/trading")
async def trading():
    return {"items": list_trading_orders()}


# The "Cash" half of Order-to-Cash — every real invoice ever created,
# across every channel (MTS's immediate ones, a Trading/Third-Party
# order's eventual one, an Export order's, all the same Invoices sheet).
@router.get("/billing")
async def billing():
    return {"items": list_invoices()}


@router.post("/billing/{invoice_id}/mark-paid", dependencies=[Depends(require_role("PLANNER"))])
async def billing_mark_paid(invoice_id: str):
    result = mark_invoice_paid(invoice_id)
    if not result["updated"]:
        raise HTTPException(status_code=400, detail=result["reason"])
    return result
