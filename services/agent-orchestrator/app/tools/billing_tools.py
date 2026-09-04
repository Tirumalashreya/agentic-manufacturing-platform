# app/tools/billing_tools.py
import datetime
import openpyxl

MOCK_ERP_PATH = "mock_erp.xlsx"

INVOICE_HEADERS = [
    "invoice_id",
    "sales_order_id",
    "delivery_id",
    "customer_id",
    "customer_name",
    "quantity_billed",
    "unit_price",
    "invoice_amount",
    "payment_terms_days",
    "due_date",
    "status",
    "notes",
    "created_at",
]


def _invoices_sheet(wb):
    if "Invoices" not in wb.sheetnames:
        sheet = wb.create_sheet("Invoices")
        sheet.append(INVOICE_HEADERS)
        return sheet
    return wb["Invoices"]


def _next_invoice_id(sheet) -> str:
    max_num = 0
    for row in sheet.iter_rows(min_row=2, values_only=True):
        value = row[0]
        if value and str(value).startswith("INV"):
            try:
                max_num = max(max_num, int(str(value)[3:]))
            except ValueError:
                pass
    return f"INV{max_num + 1:04d}"


def create_invoice(
    sales_order_id: str,
    delivery_id: str,
    customer_id: str | None,
    customer_name: str | None,
    quantity_billed: int,
    unit_price: float,
    payment_terms_days: int,
    notes: str,
) -> dict:
    if quantity_billed is None or quantity_billed <= 0 or unit_price is None:
        return {
            "created": False,
            "reason": "Cannot create an invoice without a valid billed quantity and unit price.",
        }

    # Computed here, not accepted as a caller-supplied value — same
    # principle as create_quotation()/create_sales_order().
    invoice_amount = round(unit_price * quantity_billed, 2)

    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    sheet = _invoices_sheet(wb)

    invoice_id = _next_invoice_id(sheet)
    created_at = datetime.datetime.now().isoformat()
    due_date = (datetime.date.today() + datetime.timedelta(days=payment_terms_days)).isoformat()
    status = "ISSUED"

    sheet.append([
        invoice_id,
        sales_order_id,
        delivery_id,
        customer_id,
        customer_name,
        quantity_billed,
        unit_price,
        invoice_amount,
        payment_terms_days,
        due_date,
        status,
        notes,
        created_at,
    ])
    wb.save(MOCK_ERP_PATH)

    return {
        "created": True,
        "invoice_id": invoice_id,
        "invoice_amount": invoice_amount,
        "due_date": due_date,
        "status": status,
    }
