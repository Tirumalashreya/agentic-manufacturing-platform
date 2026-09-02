import openpyxl

MOCK_ERP_PATH = "mock_erp.xlsx"


def get_stock(product_id: str) -> list[dict]:
    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    sheet = wb["Inventory"]
    results = []
    for row in sheet.iter_rows(min_row=2, values_only=True):
        pid, plant, stock_qty = row
        if pid == product_id:
            results.append({"plant": plant, "stock_qty": stock_qty})
    return results
