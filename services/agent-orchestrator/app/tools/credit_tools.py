# app/tools/credit_tools.py
import openpyxl

MOCK_ERP_PATH = "mock_erp.xlsx"

# SalesOrders sheet column indices (see sales_tools.SALES_ORDER_HEADERS)
_SALES_ORDER_CUSTOMER_ID_COL = 1
_SALES_ORDER_TOTAL_AMOUNT_COL = 7


# Deterministic — no LLM. Existing exposure is the sum of this customer's
# other Sales Orders already on record; a real system would also net out
# what's been paid, but there's no payment tracking yet, so every
# confirmed order counts as outstanding exposure.
def check_credit(
    customer_id: str | None,
    credit_limit: float | None,
    new_order_amount: float,
) -> dict:
    if customer_id is None or credit_limit is None:
        return {
            "checked": False,
            "reason": "Cannot perform a credit check without a known customer and credit limit.",
        }

    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    existing_exposure = 0.0
    if "SalesOrders" in wb.sheetnames:
        sheet = wb["SalesOrders"]
        for row in sheet.iter_rows(min_row=2, values_only=True):
            if row[_SALES_ORDER_CUSTOMER_ID_COL] == customer_id:
                existing_exposure += row[_SALES_ORDER_TOTAL_AMOUNT_COL] or 0

    total_exposure = existing_exposure + new_order_amount
    within_credit = total_exposure <= credit_limit

    return {
        "checked": True,
        "existing_exposure": existing_exposure,
        "new_order_amount": new_order_amount,
        "total_exposure": total_exposure,
        "credit_limit": credit_limit,
        "within_credit": within_credit,
    }
