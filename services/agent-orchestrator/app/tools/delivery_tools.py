# app/tools/delivery_tools.py
import datetime
import openpyxl

MOCK_ERP_PATH = "mock_erp.xlsx"

DELIVERY_HEADERS = [
    "delivery_id",
    "sales_order_id",
    "customer_id",
    "customer_name",
    "product_id",
    "product_name",
    "quantity",
    "status",
    "created_at",
]


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
) -> dict:
    if quantity is None or quantity <= 0:
        return {
            "created": False,
            "reason": "Cannot create a delivery for zero or negative quantity.",
        }

    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    sheet = _deliveries_sheet(wb)

    delivery_id = _next_delivery_id(sheet)
    created_at = datetime.datetime.now().isoformat()
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
        created_at,
    ])
    wb.save(MOCK_ERP_PATH)

    return {
        "created": True,
        "delivery_id": delivery_id,
        "status": status,
    }
