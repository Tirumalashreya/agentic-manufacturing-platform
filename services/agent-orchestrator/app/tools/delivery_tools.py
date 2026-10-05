# app/tools/delivery_tools.py
import datetime
import openpyxl

from app.tools.idempotency_tools import get_idempotent_result, record_idempotent_result

MOCK_ERP_PATH = "mock_erp.xlsx"

# Real SD behavior (agreed with the user): even a fully in-stock order
# gets a real delivery schedule — loading + transit time — not an
# instant "shipped right now." Deliberately not itself a scheduling
# engine (no capacity/route optimization) — a flat, documented lead
# time, same category of simplification as production_tools.py's
# compute_target_completion_date().
DELIVERY_LEAD_TIME_DAYS = 2

DELIVERY_HEADERS = [
    "delivery_id",
    "sales_order_id",
    "customer_id",
    "customer_name",
    "product_id",
    "product_name",
    "quantity",
    "status",
    "requested_delivery_date",
    "confirmed_delivery_date",
    "created_at",
]


def compute_confirmed_delivery_date(requested_delivery_date: str | None = None) -> str:
    """The confirmed date is never earlier than what loading+transit
    allows, but honors a later customer-requested date if one was
    given — the same real-world constraint a delivery schedule line
    actually has (can't promise sooner than logistics allows, can
    always promise the customer's own later date)."""
    earliest = datetime.date.today() + datetime.timedelta(days=DELIVERY_LEAD_TIME_DAYS)
    if requested_delivery_date:
        try:
            requested = datetime.date.fromisoformat(requested_delivery_date[:10])
            if requested > earliest:
                return requested.isoformat()
        except ValueError:
            pass
    return earliest.isoformat()


def _deliveries_sheet(wb):
    if "Deliveries" not in wb.sheetnames:
        sheet = wb.create_sheet("Deliveries")
        sheet.append(DELIVERY_HEADERS)
        return sheet
    return wb["Deliveries"]


def _next_delivery_id(sheet) -> str:
    max_num = 0
    for row in sheet.iter_rows(min_row=2, values_only=True):
        value = row[0]
        if value and str(value).startswith("DEL"):
            try:
                max_num = max(max_num, int(str(value)[3:]))
            except ValueError:
                pass
    return f"DEL{max_num + 1:04d}"


def find_delivery_by_sales_order(sales_order_id: str) -> dict | None:
    """Used by the Track Order panel — same one-delivery-per-order
    assumption as find_invoice_by_sales_order (HYBRID's stock leg and
    production leg are two separate sales-order-level deliveries only in
    the sense that each is its own _deliver_and_bill call; today neither
    path creates more than one delivery per call)."""
    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    if "Deliveries" not in wb.sheetnames:
        return None
    sheet = wb["Deliveries"]
    for row in reversed(list(sheet.iter_rows(min_row=2, values_only=True))):
        if row[1] == sales_order_id:
            return dict(zip(DELIVERY_HEADERS, row))
    return None


# Only ever called for a quantity that's actually been reserved from real
# stock — MTS in full, HYBRID's stock leg. MTO/CTO's produced quantity has
# no delivery path yet since nothing is actually finished.
def create_delivery(
    sales_order_id: str,
    customer_id: str | None,
    customer_name: str | None,
    product_id: str,
    product_name: str,
    quantity: int,
    requested_delivery_date: str | None = None,
    idempotency_key: str | None = None,
) -> dict:
    cached = get_idempotent_result(idempotency_key, "create_delivery")
    if cached is not None:
        return cached

    if quantity is None or quantity <= 0:
        return {
            "created": False,
            "reason": "Cannot create a delivery for zero or negative quantity.",
        }

    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    sheet = _deliveries_sheet(wb)

    delivery_id = _next_delivery_id(sheet)
    created_at = datetime.datetime.now().isoformat()
    confirmed_delivery_date = compute_confirmed_delivery_date(requested_delivery_date)
    status = "DISPATCHED"

    sheet.append([
        delivery_id,
        sales_order_id,
        customer_id,
        customer_name,
        product_id,
        product_name,
        quantity,
        status,
        requested_delivery_date,
        confirmed_delivery_date,
        created_at,
    ])
    wb.save(MOCK_ERP_PATH)

    result = {
        "created": True,
        "delivery_id": delivery_id,
        "status": status,
        "requested_delivery_date": requested_delivery_date,
        "confirmed_delivery_date": confirmed_delivery_date,
    }
    record_idempotent_result(idempotency_key, "create_delivery", result)
    return result
