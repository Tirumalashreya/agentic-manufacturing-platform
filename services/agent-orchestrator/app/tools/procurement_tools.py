# app/tools/procurement_tools.py
import datetime
import openpyxl

from app.tools.idempotency_tools import get_idempotent_result, idempotency_lock, read_lock, record_idempotent_result, stage_idempotent_result
from app.tools.idempotency_tools import save_workbook

MOCK_ERP_PATH = "mock_erp.xlsx"

PURCHASE_ORDER_HEADERS = [
    "purchase_order_id",
    "production_order_id",
    "component_id",
    "component_name",
    "vendor_id",
    "vendor_name",
    "quantity",
    "unit_cost",
    "total_cost",
    "expected_arrival",
    "status",
    "created_at",
]


# Deterministic — reads the real BOM against the real component inventory.
# Returns has_bom=False for any product with no BOM row at all (most
# products), so callers can skip procurement honestly rather than
# pretending a shortage check happened when there's nothing to check.
@read_lock()
def check_material_availability(product_id: str, quantity: int) -> dict:
    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    if "BOM" not in wb.sheetnames:
        return {"has_bom": False, "components": []}

    bom_sheet = wb["BOM"]
    requirements = []
    for row in bom_sheet.iter_rows(min_row=2, values_only=True):
        _bom_id, pid, component_id, component_name, qty_per_unit = row
        if pid == product_id:
            requirements.append({
                "component_id": component_id,
                "component_name": component_name,
                "required": qty_per_unit * quantity,
            })

    if not requirements:
        return {"has_bom": False, "components": []}

    inv_sheet = wb["ComponentInventory"]
    available_by_component: dict[str, int] = {}
    for row in inv_sheet.iter_rows(min_row=2, values_only=True):
        component_id, _name, _plant, stock_qty = row
        available_by_component[component_id] = available_by_component.get(component_id, 0) + (stock_qty or 0)

    components = []
    for req in requirements:
        available = available_by_component.get(req["component_id"], 0)
        shortage = max(0, req["required"] - available)
        components.append({**req, "available": available, "shortage": shortage})

    return {"has_bom": True, "components": components}


@read_lock()
def get_vendors_for_component(component_id: str) -> list[dict]:
    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    sheet = wb["Vendors"]
    vendors = []
    for row in sheet.iter_rows(min_row=2, values_only=True):
        vendor_id, vendor_name, cid, lead_time_days, unit_cost = row
        if cid == component_id:
            vendors.append({
                "vendor_id": vendor_id,
                "vendor_name": vendor_name,
                "lead_time_days": lead_time_days,
                "unit_cost": unit_cost,
            })
    return vendors


def select_optimal_vendor(vendors: list[dict], target_completion_date: str | None = None) -> dict | None:
    """
    Deterministically ranks and selects the optimal vendor for a component shortage.
    Pareto Lead-Time vs Cost Optimization:
    1. If only 1 vendor exists, return that vendor.
    2. If multiple vendors exist and a target date is specified:
       - Find all vendors whose expected arrival <= target completion date.
       - Among on-time vendors, select the one with lowest unit_cost (cheapest feasible).
       - If no vendor can arrive on time, select the fastest vendor (shortest lead time)
         to minimize delivery breach.
    3. If no target date, select the vendor with lowest unit_cost.
    """
    if not vendors:
        return None
    if len(vendors) == 1:
        return vendors[0]

    if target_completion_date:
        try:
            target_dt = datetime.date.fromisoformat(target_completion_date[:10])
            today = datetime.date.today()
            on_time_vendors = []
            for v in vendors:
                arrival = today + datetime.timedelta(days=int(v.get("lead_time_days", 0)))
                if arrival <= target_dt:
                    on_time_vendors.append(v)
            if on_time_vendors:
                return min(on_time_vendors, key=lambda v: (float(v.get("unit_cost", 0)), int(v.get("lead_time_days", 0))))
            return min(vendors, key=lambda v: (int(v.get("lead_time_days", 0)), float(v.get("unit_cost", 0))))
        except Exception:
            pass

    return min(vendors, key=lambda v: (float(v.get("unit_cost", 0)), int(v.get("lead_time_days", 0))))


def _purchase_orders_sheet(wb):
    if "PurchaseOrders" not in wb.sheetnames:
        sheet = wb.create_sheet("PurchaseOrders")
        sheet.append(PURCHASE_ORDER_HEADERS)
        return sheet
    return wb["PurchaseOrders"]


def _next_purchase_order_id(sheet) -> str:
    max_num = 0
    for row in sheet.iter_rows(min_row=2, values_only=True):
        value = row[0]
        if value and str(value).startswith("PUR"):
            try:
                max_num = max(max_num, int(str(value)[3:]))
            except ValueError:
                pass
    return f"PUR{max_num + 1:04d}"


# Independent-audit fix (confirmed before fixing — still no lock as of
# this reliability pass): same gap as sales_tools.create_sales_order,
# same fix. No HTTP/network calls anywhere in this function, so the
# whole body can safely sit under the lock.
@idempotency_lock()
def create_purchase_order(
    production_order_id: str,
    component_id: str,
    component_name: str,
    vendor_id: str,
    vendor_name: str,
    quantity: int,
    unit_cost: float,
    lead_time_days: int,
    idempotency_key: str | None = None,
) -> dict:
    cached = get_idempotent_result(idempotency_key, "create_purchase_order")
    if cached is not None:
        return cached

    if quantity is None or quantity <= 0:
        return {
            "created": False,
            "reason": "Cannot create a purchase order for zero or negative quantity.",
        }

    total_cost = round(unit_cost * quantity, 2)

    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    sheet = _purchase_orders_sheet(wb)

    purchase_order_id = _next_purchase_order_id(sheet)
    created_at = datetime.datetime.now().isoformat()
    expected_arrival = (datetime.date.today() + datetime.timedelta(days=lead_time_days)).isoformat()
    status = "ORDERED"

    sheet.append([
        purchase_order_id,
        production_order_id,
        component_id,
        component_name,
        vendor_id,
        vendor_name,
        quantity,
        unit_cost,
        total_cost,
        expected_arrival,
        status,
        created_at,
    ])
    result = {
        "created": True,
        "purchase_order_id": purchase_order_id,
        "total_cost": total_cost,
        "expected_arrival": expected_arrival,
        "status": status,
    }
    stage_idempotent_result(wb, idempotency_key, "create_purchase_order", result)
    save_workbook(wb)
    return result
