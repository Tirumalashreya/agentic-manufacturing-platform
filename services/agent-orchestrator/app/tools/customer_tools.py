import openpyxl

MOCK_ERP_PATH = "mock_erp.xlsx"


def get_customer(customer_name: str) -> dict | None:
    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    sheet = wb["Customer Master"]
    for row in sheet.iter_rows(min_row=2, values_only=True):
        customer_id, name, active, credit_limit = row
        if name == customer_name:
            return {
                "customer_id": customer_id,
                "customer_name": name,
                "active": bool(active),
                "credit_limit": credit_limit,
            }
    return None
