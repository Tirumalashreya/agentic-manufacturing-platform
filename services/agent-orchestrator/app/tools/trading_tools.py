# app/tools/trading_tools.py
import datetime
import openpyxl

from app.tools.audit_tools import record_audit_event

MOCK_ERP_PATH = "mock_erp.xlsx"

TRADING_ORDER_HEADERS = [
    "trading_order_id",
    "sales_order_id",
    "product_id",
    "product_name",
    "vendor_id",
    "vendor_name",
    "quantity",
    "unit_cost",
    "total_cost",
    "expected_arrival",
    "status",
    "created_at",
]


# Real vendors for a finished product this company doesn't manufacture —
# distinct from procurement_tools' component vendors (raw materials for
# production). Most products have none here — that's an honest empty
# result (this company makes what it sells for those), not a skipped check.
def get_vendors_for_product(product_id: str) -> list[dict]:
    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    if "ProductVendors" not in wb.sheetnames:
        return []
    sheet = wb["ProductVendors"]
    vendors = []
    for row in sheet.iter_rows(min_row=2, values_only=True):
        vendor_id, vendor_name, pid, lead_time_days, unit_cost = row
        if pid == product_id:
            vendors.append({
                "vendor_id": vendor_id,
                "vendor_name": vendor_name,
                "lead_time_days": lead_time_days,
                "unit_cost": unit_cost,
            })
    return vendors


# Real, person-triggered transitions — no time-based auto-arrival. Mirrors
# the ServiceOrder status machine: ORDERED (vendor PO placed) -> RECEIVED
# (goods physically arrived) -> QC_PASSED or QC_FAILED -> WAREHOUSED
# (QC_PASSED only; this is what actually credits sellable inventory).
# DISPATCHED is not in here — it also triggers real delivery/billing via
# the Billing Agent, so it lives as dispatch_trading_order() in graph.py
# where agent calls happen, not in this deterministic-only tools module.
_VALID_STATUS_TRANSITIONS = {
    "ORDERED": {"RECEIVED"},
    "RECEIVED": {"QC_PASSED", "QC_FAILED"},
    "QC_PASSED": {"WAREHOUSED"},
}


def _trading_orders_sheet(wb):
    if "TradingOrders" not in wb.sheetnames:
        sheet = wb.create_sheet("TradingOrders")
        sheet.append(TRADING_ORDER_HEADERS)
        return sheet
    return wb["TradingOrders"]


def _next_trading_order_id(sheet) -> str:
    max_num = 0
    for row in sheet.iter_rows(min_row=2, values_only=True):
        value = row[0]
        if value and str(value).startswith("TO"):
            try:
                max_num = max(max_num, int(str(value)[2:]))
            except ValueError:
                pass
    return f"TO{max_num + 1:04d}"


def create_trading_order(
    sales_order_id: str,
    product_id: str,
    product_name: str,
    vendor_id: str,
    vendor_name: str,
    quantity: int,
    unit_cost: float,
    lead_time_days: int,
) -> dict:
    if quantity is None or quantity <= 0:
        return {
            "created": False,
            "reason": "Cannot create a trading order for zero or negative quantity.",
        }

    total_cost = round(unit_cost * quantity, 2)

    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    sheet = _trading_orders_sheet(wb)

    trading_order_id = _next_trading_order_id(sheet)
    created_at = datetime.datetime.now().isoformat()
    expected_arrival = (datetime.date.today() + datetime.timedelta(days=lead_time_days)).isoformat()
    status = "ORDERED"

    sheet.append([
        trading_order_id,
        sales_order_id,
        product_id,
        product_name,
        vendor_id,
        vendor_name,
        quantity,
        unit_cost,
        total_cost,
        expected_arrival,
        status,
        created_at,
    ])
    wb.save(MOCK_ERP_PATH)
    record_audit_event("TradingOrder", trading_order_id, "TRADING_ORDER_CREATED", {"total_cost": total_cost})

    return {
        "created": True,
        "trading_order_id": trading_order_id,
        "total_cost": total_cost,
        "expected_arrival": expected_arrival,
        "status": status,
    }


def find_trading_order(trading_order_id: str) -> dict | None:
    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    if "TradingOrders" not in wb.sheetnames:
        return None
    sheet = wb["TradingOrders"]
    for row in sheet.iter_rows(min_row=2, values_only=True):
        if row[0] == trading_order_id:
            return dict(zip(TRADING_ORDER_HEADERS, row))
    return None


# ORDERED -> RECEIVED -> QC_PASSED/QC_FAILED -> WAREHOUSED. WAREHOUSED is
# the point real sellable inventory is credited (same "credit stock on
# approval" pattern as resolve_return_inspection — including its same
# known limitation of crediting whichever plant's Inventory row it finds
# first for the product, not a specific plant). QC_FAILED is terminal —
# vendor liability/replacement handling is a real gap, not faked here.
# DISPATCHED is deliberately not reachable through this function — see
# dispatch_trading_order() in graph.py, which also bills.
def update_trading_order_status(trading_order_id: str, new_status: str) -> dict:
    if new_status not in {"RECEIVED", "QC_PASSED", "QC_FAILED", "WAREHOUSED"}:
        return {"updated": False, "reason": f"Invalid status: {new_status}"}

    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    if "TradingOrders" not in wb.sheetnames:
        return {"updated": False, "reason": f"No trading order found with id {trading_order_id}"}
    sheet = wb["TradingOrders"]

    status_col = TRADING_ORDER_HEADERS.index("status") + 1
    product_id_col = TRADING_ORDER_HEADERS.index("product_id") + 1
    quantity_col = TRADING_ORDER_HEADERS.index("quantity") + 1

    for row_idx, row in enumerate(sheet.iter_rows(min_row=2), start=2):
        if row[0].value != trading_order_id:
            continue
        current_status = row[status_col - 1].value
        allowed = _VALID_STATUS_TRANSITIONS.get(current_status, set())
        if new_status not in allowed:
            return {
                "updated": False,
                "reason": (
                    f"Cannot move {trading_order_id} from {current_status} to {new_status}. "
                    f"Allowed next status(es): {sorted(allowed) or 'none — terminal'}."
                ),
            }

        sheet.cell(row=row_idx, column=status_col, value=new_status)

        if new_status == "WAREHOUSED":
            product_id = row[product_id_col - 1].value
            quantity = row[quantity_col - 1].value
            inventory = wb["Inventory"]
            for inv_row in inventory.iter_rows(min_row=2):
                pid_cell, _plant_cell, qty_cell = inv_row
                if pid_cell.value == product_id:
                    qty_cell.value = (qty_cell.value or 0) + quantity
                    break

        wb.save(MOCK_ERP_PATH)
        record_audit_event("TradingOrder", trading_order_id, f"TRADING_ORDER_{new_status}")
        return {"updated": True, "trading_order_id": trading_order_id, "status": new_status}

    return {"updated": False, "reason": f"No trading order found with id {trading_order_id}"}


# Narrow, separate from update_trading_order_status() on purpose: DISPATCHED
# is only ever set by dispatch_trading_order() in graph.py, after delivery
# has actually been created there — this function doesn't decide that, it
# just records it once the caller has already made it real.
def mark_trading_order_dispatched(trading_order_id: str) -> dict:
    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    if "TradingOrders" not in wb.sheetnames:
        return {"updated": False, "reason": f"No trading order found with id {trading_order_id}"}
    sheet = wb["TradingOrders"]
    status_col = TRADING_ORDER_HEADERS.index("status") + 1

    for row_idx, row in enumerate(sheet.iter_rows(min_row=2), start=2):
        if row[0].value != trading_order_id:
            continue
        current_status = row[status_col - 1].value
        if current_status != "WAREHOUSED":
            return {
                "updated": False,
                "reason": f"{trading_order_id} must be WAREHOUSED before it can be dispatched (status: {current_status}).",
            }
        sheet.cell(row=row_idx, column=status_col, value="DISPATCHED")
        wb.save(MOCK_ERP_PATH)
        record_audit_event("TradingOrder", trading_order_id, "TRADING_ORDER_DISPATCHED")
        return {"updated": True, "trading_order_id": trading_order_id, "status": "DISPATCHED"}

    return {"updated": False, "reason": f"No trading order found with id {trading_order_id}"}
