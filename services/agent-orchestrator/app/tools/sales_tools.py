# app/tools/sales_tools.py
import datetime
import openpyxl

MOCK_ERP_PATH = "mock_erp.xlsx"

QUOTATION_HEADERS = [
    "quotation_id",
    "customer_id",
    "customer_name",
    "product_id",
    "product_name",
    "quantity",
    "quoted_price",
    "total_amount",
    "valid_for_days",
    "valid_until",
    "status",
    "notes",
    "created_at",
]

SALES_ORDER_HEADERS = [
    "sales_order_id",
    "customer_id",
    "customer_name",
    "product_id",
    "product_name",
    "quantity",
    "unit_price",
    "total_amount",
    "requested_deadline",
    "status",
    "created_at",
]


def _quotations_sheet(wb):
    if "Quotations" not in wb.sheetnames:
        sheet = wb.create_sheet("Quotations")
        sheet.append(QUOTATION_HEADERS)
        return sheet
    return wb["Quotations"]


def _next_id(sheet, prefix: str) -> str:
    # Based on the max existing numeric suffix, not row count — robust to
    # any row ever being deleted (row-count-based IDs can collide with a
    # still-existing higher-numbered row after a deletion).
    max_num = 0
    for row in sheet.iter_rows(min_row=2, values_only=True):
        value = row[0]
        if value and str(value).startswith(prefix):
            try:
                max_num = max(max_num, int(str(value)[len(prefix):]))
            except ValueError:
                pass
    return f"{prefix}{max_num + 1:04d}"


def _next_quotation_id(sheet) -> str:
    return _next_id(sheet, "Q")


def create_quotation(
    customer_id: str | None,
    customer_name: str | None,
    product_id: str | None,
    product_name: str | None,
    quantity: int | None,
    quoted_price: float | None,
    valid_for_days: int,
    notes: str,
) -> dict:
    # Deterministic guard — a quotation with no real product, no price, or
    # no sensible quantity isn't a business transaction worth recording.
    if (
        product_id is None
        or quoted_price is None
        or quantity is None
        or quantity <= 0
    ):
        return {
            "created": False,
            "reason": "Cannot create a quotation without a valid product, price, and quantity.",
        }

    # Computed here, not accepted as a caller-supplied value — a total
    # cannot silently drift from quoted_price * quantity.
    total_amount = round(quoted_price * quantity, 2)

    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    sheet = _quotations_sheet(wb)

    quotation_id = _next_quotation_id(sheet)
    created_at = datetime.datetime.now().isoformat()
    valid_until = (datetime.date.today() + datetime.timedelta(days=valid_for_days)).isoformat()
    status = "OPEN"

    sheet.append([
        quotation_id,
        customer_id,
        customer_name,
        product_id,
        product_name,
        quantity,
        quoted_price,
        total_amount,
        valid_for_days,
        valid_until,
        status,
        notes,
        created_at,
    ])
    wb.save(MOCK_ERP_PATH)

    return {
        "created": True,
        "quotation_id": quotation_id,
        "total_amount": total_amount,
        "valid_until": valid_until,
        "status": status,
    }


def _sales_orders_sheet(wb):
    if "SalesOrders" not in wb.sheetnames:
        sheet = wb.create_sheet("SalesOrders")
        sheet.append(SALES_ORDER_HEADERS)
        return sheet
    return wb["SalesOrders"]


def _next_sales_order_id(sheet) -> str:
    return _next_id(sheet, "SO")


def create_sales_order(
    customer_id: str | None,
    customer_name: str | None,
    customer_active: bool,
    product_id: str | None,
    product_name: str | None,
    quantity: int | None,
    unit_price: float | None,
    requested_deadline: str | None,
) -> dict:
    # A Sales Order is a real commitment, not a pre-sales quote to a
    # prospect — unlike create_quotation(), it requires an actual,
    # active registered customer, not just a valid product/price.
    if customer_id is None or not customer_active:
        return {
            "created": False,
            "reason": "Cannot create a sales order for an unknown or inactive customer.",
        }
    if product_id is None or unit_price is None:
        return {
            "created": False,
            "reason": "Cannot create a sales order without a valid product and price.",
        }
    if quantity is None or quantity <= 0:
        return {
            "created": False,
            "reason": "Cannot create a sales order without a valid quantity.",
        }

    total_amount = round(unit_price * quantity, 2)

    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    sheet = _sales_orders_sheet(wb)

    sales_order_id = _next_sales_order_id(sheet)
    created_at = datetime.datetime.now().isoformat()
    status = "CONFIRMED"

    sheet.append([
        sales_order_id,
        customer_id,
        customer_name,
        product_id,
        product_name,
        quantity,
        unit_price,
        total_amount,
        requested_deadline,
        status,
        created_at,
    ])
    wb.save(MOCK_ERP_PATH)

    return {
        "created": True,
        "sales_order_id": sales_order_id,
        "total_amount": total_amount,
        "status": status,
    }


# The persisted SalesOrders row must reflect reality — a credit hold means
# the real record says CREDIT_BLOCKED, not just LangGraph state saying
# ON_CREDIT_HOLD while the sheet still claims CONFIRMED.
def update_sales_order_status(sales_order_id: str, new_status: str) -> dict:
    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    sheet = _sales_orders_sheet(wb)

    status_col = SALES_ORDER_HEADERS.index("status") + 1
    for row_idx, row in enumerate(sheet.iter_rows(min_row=2), start=2):
        if row[0].value == sales_order_id:
            sheet.cell(row=row_idx, column=status_col, value=new_status)
            wb.save(MOCK_ERP_PATH)
            return {"updated": True, "sales_order_id": sales_order_id, "status": new_status}

    return {"updated": False, "reason": f"No sales order found with id {sales_order_id}"}
