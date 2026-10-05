# app/routers/masterdata.py
from fastapi import APIRouter

from app.tools.customer_tools import list_customers
from app.tools.product_tools import list_products

router = APIRouter(prefix="/masterdata")


# Backs UI-side pickers (e.g. the Domestic Sales booking form) that
# compose a request rather than replace the agent pipeline — real
# Customer Master / Product Master rows, not a hardcoded dropdown list.
@router.get("/customers")
async def customers():
    return {"items": list_customers()}


@router.get("/products")
async def products():
    return {"items": list_products()}
