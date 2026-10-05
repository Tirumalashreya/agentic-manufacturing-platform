# app/tools/idempotency_tools.py
import datetime
import json
import openpyxl

MOCK_ERP_PATH = "mock_erp.xlsx"

IDEMPOTENCY_HEADERS = ["idempotency_key", "operation", "result", "created_at"]

# The one shared primitive real idempotency actually needs — not a
# framework, just a key/operation -> prior-result lookup. Wired only into
# the operations PLAN.md names (Sales Order, Purchase Order, Delivery,
# Invoice, Credit Memo, Debit Memo): a retried create request for the
# same key returns the exact result it returned the first time instead of
# creating a second real record. Purely additive — idempotency_key is
# optional everywhere it's used, so no existing caller or test is
# affected by not passing one.


def _sheet(wb):
    if "IdempotencyKeys" not in wb.sheetnames:
        sheet = wb.create_sheet("IdempotencyKeys")
        sheet.append(IDEMPOTENCY_HEADERS)
        return sheet
    return wb["IdempotencyKeys"]


def get_idempotent_result(idempotency_key: str | None, operation: str) -> dict | None:
    if not idempotency_key:
        return None
    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    if "IdempotencyKeys" not in wb.sheetnames:
        return None
    sheet = wb["IdempotencyKeys"]
    for row in sheet.iter_rows(min_row=2, values_only=True):
        key, op, result_json, _created_at = row
        if key == idempotency_key and op == operation:
            return json.loads(result_json)
    return None


def record_idempotent_result(idempotency_key: str | None, operation: str, result: dict) -> None:
    if not idempotency_key:
        return
    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    sheet = _sheet(wb)
    sheet.append([idempotency_key, operation, json.dumps(result), datetime.datetime.now().isoformat()])
    wb.save(MOCK_ERP_PATH)
