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
    # Real SAP-aligned distinction (agreed with the user): does this
    # vendor ship straight to the customer, or through our own
    # warehouse first? Set once, at creation, from the selected
    # vendor's own ships_direct_to_customer flag — never changes after
    # that, since it determines which status machine below applies.
    "drop_ship",
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
        vendor_id, vendor_name, pid, lead_time_days, unit_cost = row[:5]
        # Real vendor-master data (SAP would call this a "special
        # procurement" indicator on the vendor-material relationship):
        # can THIS vendor ship straight to the customer, or does it come
        # through our own warehouse first? Defaults to False (warehouse
        # route) for any row predating this column, never assumed True.
        ships_direct = bool(row[5]) if len(row) > 5 and row[5] is not None else False
        if pid == product_id:
            vendors.append({
                "vendor_id": vendor_id,
                "vendor_name": vendor_name,
                "lead_time_days": lead_time_days,
                "unit_cost": unit_cost,
                "ships_direct_to_customer": ships_direct,
            })
    return vendors


# Real, person-triggered transitions — no time-based auto-arrival. Two
# genuinely different lifecycles share this table now, branching right
# after ORDERED depending on the order's own drop_ship flag:
#   Warehouse route (drop_ship=False): ORDERED -> RECEIVED (goods
#     physically arrive AT US) -> QC_PASSED/QC_FAILED -> WAREHOUSED
#     (QC_PASSED only; this is what actually credits sellable inventory).
#   Drop-ship route (drop_ship=True): ORDERED -> SHIPPED (vendor ships
#     straight to the customer — nothing arrives here, nothing gets
#     QC'd, nothing is ever credited to our inventory) -> DELIVERED.
# DISPATCHED/DELIVERED aren't in this map — both also trigger real
# delivery/billing via the Billing Agent, so they live as
# dispatch_trading_order()/deliver_drop_ship_order() in graph.py where
# agent calls happen, not in this deterministic-only tools module.
_VALID_STATUS_TRANSITIONS = {
    "ORDERED": {"RECEIVED", "SHIPPED"},
    "RECEIVED": {"QC_PASSED", "QC_FAILED"},
    "QC_PASSED": {"WAREHOUSED"},
    "SHIPPED": {"DELIVERED"},
}

# Which statuses belong to which route — used to reject a transition
# that's real in the abstract (e.g. RECEIVED exists) but wrong for THIS
# order's actual route (a drop-ship order never gets RECEIVED here; it
# never comes here at all).
_WAREHOUSE_ROUTE_STATUSES = frozenset({"RECEIVED", "QC_PASSED", "QC_FAILED", "WAREHOUSED"})
_DROP_SHIP_ROUTE_STATUSES = frozenset({"SHIPPED", "DELIVERED"})


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
    drop_ship: bool = False,
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
        drop_ship,
    ])
    wb.save(MOCK_ERP_PATH)
    record_audit_event(
        "TradingOrder", trading_order_id, "TRADING_ORDER_CREATED",
        {"total_cost": total_cost, "drop_ship": drop_ship},
    )

    return {
        "created": True,
        "trading_order_id": trading_order_id,
        "total_cost": total_cost,
        "expected_arrival": expected_arrival,
        "status": status,
        "drop_ship": drop_ship,
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


# DISPATCHED (warehouse route), DELIVERED (drop-ship route), and
# QC_FAILED are this sheet's terminal states — everything else
# (ORDERED/RECEIVED/QC_PASSED/WAREHOUSED/SHIPPED) is mid-flight and
# needs a human to move it along.
# Full history for the Trading channel view — includes every terminal
# state, unlike list_open_trading_orders() which powers Active Workflows.
def list_trading_orders() -> list[dict]:
    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    if "TradingOrders" not in wb.sheetnames:
        return []
    sheet = wb["TradingOrders"]
    rows = [dict(zip(TRADING_ORDER_HEADERS, row)) for row in sheet.iter_rows(min_row=2, values_only=True)]
    rows.reverse()
    return rows


def list_open_trading_orders() -> list[dict]:
    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    if "TradingOrders" not in wb.sheetnames:
        return []
    sheet = wb["TradingOrders"]
    status_idx = TRADING_ORDER_HEADERS.index("status")
    return [
        dict(zip(TRADING_ORDER_HEADERS, row))
        for row in sheet.iter_rows(min_row=2, values_only=True)
        if row[status_idx] not in ("DISPATCHED", "DELIVERED", "QC_FAILED")
    ]


# ORDERED -> RECEIVED -> QC_PASSED/QC_FAILED -> WAREHOUSED. WAREHOUSED is
# the point real sellable inventory is credited (same "credit stock on
# approval" pattern as resolve_return_inspection — including its same
# known limitation of crediting whichever plant's Inventory row it finds
# first for the product, not a specific plant). QC_FAILED is terminal —
# vendor liability/replacement handling is a real gap, not faked here.
# DISPATCHED is deliberately not reachable through this function — see
# dispatch_trading_order() in graph.py, which also bills.
def update_trading_order_status(trading_order_id: str, new_status: str) -> dict:
    if new_status not in {"RECEIVED", "QC_PASSED", "QC_FAILED", "WAREHOUSED", "SHIPPED"}:
        return {"updated": False, "reason": f"Invalid status: {new_status}"}

    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    if "TradingOrders" not in wb.sheetnames:
        return {"updated": False, "reason": f"No trading order found with id {trading_order_id}"}
    sheet = wb["TradingOrders"]

    status_col = TRADING_ORDER_HEADERS.index("status") + 1
    product_id_col = TRADING_ORDER_HEADERS.index("product_id") + 1
    quantity_col = TRADING_ORDER_HEADERS.index("quantity") + 1
    drop_ship_col = TRADING_ORDER_HEADERS.index("drop_ship") + 1

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

        is_drop_ship = bool(row[drop_ship_col - 1].value) if len(row) >= drop_ship_col else False
        if is_drop_ship and new_status in _WAREHOUSE_ROUTE_STATUSES:
            return {
                "updated": False,
                "reason": f"{trading_order_id} is a drop-ship order — the vendor ships straight to the customer, so it never enters our warehouse and can't move to {new_status}.",
            }
        if not is_drop_ship and new_status in _DROP_SHIP_ROUTE_STATUSES:
            return {
                "updated": False,
                "reason": f"{trading_order_id} routes through our own warehouse — it can't skip to {new_status}.",
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


# The drop-ship counterpart to mark_trading_order_dispatched() — same
# narrow "record it after it's already real" role, for the route that
# skips our warehouse entirely. Only ever called by
# deliver_drop_ship_order() in graph.py, after that function has already
# created the real delivery/invoice.
def mark_trading_order_delivered(trading_order_id: str) -> dict:
    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    if "TradingOrders" not in wb.sheetnames:
        return {"updated": False, "reason": f"No trading order found with id {trading_order_id}"}
    sheet = wb["TradingOrders"]
    status_col = TRADING_ORDER_HEADERS.index("status") + 1

    for row_idx, row in enumerate(sheet.iter_rows(min_row=2), start=2):
        if row[0].value != trading_order_id:
            continue
        current_status = row[status_col - 1].value
        if current_status != "SHIPPED":
            return {
                "updated": False,
                "reason": f"{trading_order_id} must be SHIPPED before it can be marked delivered (status: {current_status}).",
            }
        sheet.cell(row=row_idx, column=status_col, value="DELIVERED")
        wb.save(MOCK_ERP_PATH)
        record_audit_event("TradingOrder", trading_order_id, "TRADING_ORDER_DELIVERED")
        return {"updated": True, "trading_order_id": trading_order_id, "status": "DELIVERED"}

    return {"updated": False, "reason": f"No trading order found with id {trading_order_id}"}
