# app/tools/customer_tools.py
import openpyxl

MOCK_ERP_PATH = "mock_erp.xlsx"


def get_customer(customer_name: str) -> dict | None:
    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    sheet = wb["Customer Master"]
    rows = list(sheet.iter_rows(min_row=2, values_only=True))

    for customer_id, name, active, credit_limit in rows:
        if name.lower() == customer_name.lower():
            return {
                "customer_id": customer_id,
                "customer_name": name,
                "active": bool(active),
                "credit_limit": credit_limit,
            }

    # Fall back to substring match either direction — same deterministic
    # pattern as find_subscription_plan()/find_service_rate() — so a
    # shorthand like "ABC" still resolves to "ABC Corp". No LLM round-trip
    # needed; unlike product names, no real customer name here is a
    # substring of another, so this stays unambiguous.
    needle = customer_name.strip().lower()
    for customer_id, name, active, credit_limit in rows:
        haystack = name.strip().lower()
        if needle in haystack or haystack in needle:
            return {
                "customer_id": customer_id,
                "customer_name": name,
                "active": bool(active),
                "credit_limit": credit_limit,
            }

    return None
