# app/tools/inventory_tools.py
import openpyxl

from app.tools.idempotency_tools import read_lock

MOCK_ERP_PATH = "mock_erp.xlsx"


# Reliability-pass fix: one of the high-traffic read functions the
# independent audit named explicitly (called from graph.py and
# plan_executor.py all over the order-fulfillment/export-allocation
# paths) — never checked any lock, so it could observe a torn
# mock_erp.xlsx mid-save from reserve_stock or any other writer.
@read_lock()
def get_stock(product_id: str) -> list[dict]:
    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    sheet = wb["Inventory"]
    results = []
    for row in sheet.iter_rows(min_row=2, values_only=True):
        pid, plant, stock_qty = row
        if pid == product_id:
            results.append({"plant": plant, "stock_qty": stock_qty})
    return results
