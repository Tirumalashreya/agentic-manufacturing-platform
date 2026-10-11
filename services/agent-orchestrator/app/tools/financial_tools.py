# app/tools/financial_tools.py
import datetime
import openpyxl

from app.tools.audit_tools import record_audit_event
from app.tools.idempotency_tools import get_idempotent_result, idempotency_lock, record_idempotent_result

MOCK_ERP_PATH = "mock_erp.xlsx"

FINANCIAL_ADJUSTMENT_HEADERS = [
    "financial_adjustment_id",
    "adjustment_type",
    "customer_id",
    "customer_name",
    "reference",
    "amount",
    "reason",
    "approval_required",
    "approved_by",
    "approved_at",
    "status",
    "created_at",
    "posted_at",
]

# A flat, policy-constant threshold — same pattern as RETURN_WINDOW_DAYS
# and RETENTION_PERCENT elsewhere. Below it, a financial adjustment posts
# immediately; at or above it, a human has to approve it first, per
# PLAN.md's own rule that approval gates are for real-consequence actions
# (a large credit memo), not blanket-applied to every step.
FINANCIAL_APPROVAL_THRESHOLD = 50_000


def _adjustments_sheet(wb):
    if "FinancialAdjustments" not in wb.sheetnames:
        sheet = wb.create_sheet("FinancialAdjustments")
        sheet.append(FINANCIAL_ADJUSTMENT_HEADERS)
        return sheet
    return wb["FinancialAdjustments"]


def _next_id(sheet) -> str:
    max_num = 0
    for row in sheet.iter_rows(min_row=2, values_only=True):
        value = row[0]
        if value and str(value).startswith("FA"):
            try:
                max_num = max(max_num, int(str(value)[2:]))
            except ValueError:
                pass
    return f"FA{max_num + 1:04d}"


def find_financial_adjustment(financial_adjustment_id: str) -> dict | None:
    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    if "FinancialAdjustments" not in wb.sheetnames:
        return None
    sheet = wb["FinancialAdjustments"]
    for row in sheet.iter_rows(min_row=2, values_only=True):
        if row[0] == financial_adjustment_id:
            return dict(zip(FINANCIAL_ADJUSTMENT_HEADERS, row))
    return None


# PENDING_APPROVAL needs a decision; APPROVED needs posting — REJECTED and
# POSTED are terminal, so those two statuses are exactly "still needs a
# human to do something", the same set the Approvals UI acts on.
def list_actionable_financial_adjustments() -> list[dict]:
    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    if "FinancialAdjustments" not in wb.sheetnames:
        return []
    sheet = wb["FinancialAdjustments"]
    return [
        dict(zip(FINANCIAL_ADJUSTMENT_HEADERS, row))
        for row in sheet.iter_rows(min_row=2, values_only=True)
        if row[10] in ("PENDING_APPROVAL", "APPROVED")
    ]


# The agent extracts adjustment_type/reference/reason — never the amount
# unless the customer actually stated one, and this rejects outright if
# it's missing, rather than posting a financial document for an unknown
# sum. Never invented downstream either: this only ever transcribes what
# was already extracted.
@idempotency_lock()
def create_financial_adjustment(
    adjustment_type: str,
    customer_id: str | None,
    customer_name: str | None,
    reference: str | None,
    amount: float | None,
    reason: str,
    idempotency_key: str | None = None,
) -> dict:
    cached = get_idempotent_result(idempotency_key, "create_financial_adjustment")
    if cached is not None:
        return cached

    if amount is None or amount <= 0:
        return {
            "created": False,
            "reason": "Cannot create a financial adjustment without a real, stated amount.",
        }

    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    sheet = _adjustments_sheet(wb)
    financial_adjustment_id = _next_id(sheet)
    created_at = datetime.datetime.now().isoformat()

    approval_required = amount >= FINANCIAL_APPROVAL_THRESHOLD
    status = "PENDING_APPROVAL" if approval_required else "APPROVED"

    sheet.append([
        financial_adjustment_id, adjustment_type, customer_id, customer_name,
        reference, amount, reason, approval_required, None, None,
        status, created_at, None,
    ])
    wb.save(MOCK_ERP_PATH)
    record_audit_event("FinancialAdjustment", financial_adjustment_id, "FINANCIAL_ADJUSTMENT_CREATED", {
        "adjustment_type": adjustment_type, "amount": amount,
    })

    result = {
        "created": True,
        "financial_adjustment_id": financial_adjustment_id,
        "approval_required": approval_required,
        "status": status,
    }
    record_idempotent_result(idempotency_key, "create_financial_adjustment", result)
    return result


# The human-in-the-loop step — not called by an agent, same principle as
# approval_tools.resolve_approval_request().
#
# Independent-audit finding (confirmed before fixing): find_financial_adjustment
# and the write below used to be two SEPARATE load_workbook calls with no
# lock between them — two concurrent resolves of the same PENDING_APPROVAL
# adjustment could both pass the status check before either wrote, a
# classic TOCTOU race with real monetary impact (unlike the sales-order/
# reschedule approval paths, which were already protected by
# app/db.py's atomic claim_approval CAS). @idempotency_lock() now wraps
# this whole function, so the status read above only ever happens after
# acquiring exclusive access — the second of two concurrent calls sees the
# FIRST call's already-applied status change, not a stale PENDING_APPROVAL
# snapshot. idempotency_key additionally protects a genuine retry (e.g. a
# double-clicked Approve button) from re-running the decision at all.
@idempotency_lock()
def resolve_financial_approval(
    financial_adjustment_id: str, decision: str, approved_by: str = "SYSTEM", idempotency_key: str | None = None
) -> dict:
    cached = get_idempotent_result(idempotency_key, "resolve_financial_approval")
    if cached is not None:
        return cached

    if decision not in ("APPROVED", "REJECTED"):
        return {"resolved": False, "reason": f"Invalid decision: {decision}"}

    adjustment = find_financial_adjustment(financial_adjustment_id)
    if adjustment is None:
        return {"resolved": False, "reason": f"No financial adjustment found with id {financial_adjustment_id}"}
    if adjustment["status"] != "PENDING_APPROVAL":
        return {
            "resolved": False,
            "reason": f"{financial_adjustment_id} is not PENDING_APPROVAL (status: {adjustment['status']}).",
        }

    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    sheet = wb["FinancialAdjustments"]
    status_col = FINANCIAL_ADJUSTMENT_HEADERS.index("status") + 1
    approved_by_col = FINANCIAL_ADJUSTMENT_HEADERS.index("approved_by") + 1
    approved_at_col = FINANCIAL_ADJUSTMENT_HEADERS.index("approved_at") + 1

    for row_idx, row in enumerate(sheet.iter_rows(min_row=2), start=2):
        if row[0].value != financial_adjustment_id:
            continue
        new_status = "APPROVED" if decision == "APPROVED" else "REJECTED"
        sheet.cell(row=row_idx, column=status_col, value=new_status)
        sheet.cell(row=row_idx, column=approved_by_col, value=approved_by)
        sheet.cell(row=row_idx, column=approved_at_col, value=datetime.datetime.now().isoformat())
        wb.save(MOCK_ERP_PATH)
        record_audit_event("FinancialAdjustment", financial_adjustment_id, f"FINANCIAL_ADJUSTMENT_{new_status}", {"approved_by": approved_by})
        result = {"resolved": True, "financial_adjustment_id": financial_adjustment_id, "status": new_status}
        record_idempotent_result(idempotency_key, "resolve_financial_approval", result)
        return result

    return {"resolved": False, "reason": f"No financial adjustment found with id {financial_adjustment_id}"}


# Terminal. Only an APPROVED adjustment (whether that came from
# auto-approval under the threshold, or a real human resolving the
# PENDING_APPROVAL gate) can be posted. Same race fix as
# resolve_financial_approval above, for the same reason: two concurrent
# posts of the same APPROVED adjustment could otherwise both pass the
# status check before either wrote.
@idempotency_lock()
def post_financial_adjustment(financial_adjustment_id: str, idempotency_key: str | None = None) -> dict:
    cached = get_idempotent_result(idempotency_key, "post_financial_adjustment")
    if cached is not None:
        return cached

    adjustment = find_financial_adjustment(financial_adjustment_id)
    if adjustment is None:
        return {"posted": False, "reason": f"No financial adjustment found with id {financial_adjustment_id}"}
    if adjustment["status"] != "APPROVED":
        return {
            "posted": False,
            "reason": f"Cannot post {financial_adjustment_id} from status {adjustment['status']} (expected APPROVED).",
        }

    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    sheet = wb["FinancialAdjustments"]
    status_col = FINANCIAL_ADJUSTMENT_HEADERS.index("status") + 1
    posted_at_col = FINANCIAL_ADJUSTMENT_HEADERS.index("posted_at") + 1

    for row_idx, row in enumerate(sheet.iter_rows(min_row=2), start=2):
        if row[0].value != financial_adjustment_id:
            continue
        sheet.cell(row=row_idx, column=status_col, value="POSTED")
        sheet.cell(row=row_idx, column=posted_at_col, value=datetime.datetime.now().isoformat())
        wb.save(MOCK_ERP_PATH)
        record_audit_event("FinancialAdjustment", financial_adjustment_id, "FINANCIAL_ADJUSTMENT_POSTED")
        result = {"posted": True, "financial_adjustment_id": financial_adjustment_id, "status": "POSTED"}
        record_idempotent_result(idempotency_key, "post_financial_adjustment", result)
        return result

    return {"posted": False, "reason": f"No financial adjustment found with id {financial_adjustment_id}"}
