# app/routers/workflows.py
from fastapi import APIRouter

from app.tools.consignment_tools import list_open_consignments
from app.tools.export_tools import list_open_export_orders
from app.tools.post_sales_tools import list_pending_return_inspections
from app.tools.project_tools import list_open_milestones
from app.tools.sales_tools import list_credit_blocked_orders
from app.tools.service_tools import list_open_service_orders
from app.tools.trading_tools import list_open_trading_orders

router = APIRouter(prefix="/workflows")


# Financial Adjustments are deliberately excluded — they already have
# their own dedicated Approvals page/endpoint (app/routers/approvals.py),
# and duplicating them here would just be the same queue item shown twice.
# Subscriptions are excluded too: an ACTIVE subscription has no pending
# human action until a renew/cancel request actually arrives (a new chat
# turn, not an operational follow-up), so it never belongs in this queue.
@router.get("/active")
async def active_workflows():
    items = []

    for row in list_credit_blocked_orders():
        items.append({
            "domain": "SALES_ORDER",
            "id": row["sales_order_id"],
            "status": row["status"],
            "customer_name": row["customer_name"],
            "summary": f"{row['quantity']} x {row['product_name']}",
            "amount": row["total_amount"],
            "created_at": row["created_at"],
        })

    for row in list_open_milestones():
        items.append({
            "domain": "PROJECT_MILESTONE",
            "id": row["milestone_id"],
            "status": row["status"],
            "customer_name": None,
            "summary": f"{row['milestone_name']} ({row['project_id']})",
            "amount": row["amount"],
            "created_at": None,
        })

    for row in list_open_export_orders():
        items.append({
            "domain": "EXPORT_ORDER",
            "id": row["export_order_id"],
            "status": row["status"],
            "customer_name": row["customer_name"],
            "summary": f"{row['quantity']} x {row['product_name']} to {row['destination_country']}",
            "amount": row["total_value"],
            "created_at": row["created_at"],
        })

    for row in list_open_consignments():
        items.append({
            "domain": "CONSIGNMENT",
            "id": row["consignment_id"],
            "status": row["status"],
            "customer_name": row["customer_name"],
            "summary": f"{row['quantity_remaining']} of {row['quantity_sent']} x {row['product_name']} remaining",
            "amount": None,
            "created_at": row["created_at"],
        })

    for row in list_open_service_orders():
        items.append({
            "domain": "SERVICE_ORDER",
            "id": row["service_order_id"],
            "status": row["status"],
            "customer_name": row["customer_name"],
            "summary": row["service_type"],
            "amount": row["estimated_amount"],
            "created_at": row["created_at"],
        })

    for row in list_pending_return_inspections():
        items.append({
            "domain": "RETURN",
            "id": row["post_sales_id"],
            "status": row["status"],
            "customer_name": row["customer_name"],
            "summary": f"{row['quantity']} x {row['product_name']} (order {row['referenced_order_id']})",
            "amount": row["amount"],
            "created_at": row["created_at"],
        })

    for row in list_open_trading_orders():
        items.append({
            "domain": "TRADING_ORDER",
            "id": row["trading_order_id"],
            "status": row["status"],
            "customer_name": None,
            "summary": f"{row['quantity']} x {row['product_name']} from {row['vendor_name']}",
            "amount": row["total_cost"],
            "created_at": row["created_at"],
        })

    return {"items": items}
