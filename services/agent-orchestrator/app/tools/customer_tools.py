# app/tools/customer_tools.py
import openpyxl

import logging

from app.integrations.order_domain import (
    allocate_document_number,
    find_or_create_customer_sync,
    postgres_customer_authority_enabled,
)
from app.tools.idempotency_tools import idempotency_lock, read_lock, save_workbook

logger = logging.getLogger(__name__)

from app.tools.audit_tools import record_audit_event

MOCK_ERP_PATH = "mock_erp.xlsx"

# A brand-new customer has no order history, so there's nothing real to
# base a credit limit on — this is a stated business policy (every new
# account starts here, same limit for everyone, until someone reviews
# and raises it), not a guessed number. Kept as a named constant, same
# pattern as RETURN_WINDOW_DAYS/SERVICE_PAYMENT_TERMS_DAYS elsewhere.
NEW_CUSTOMER_STARTER_CREDIT_LIMIT = 50_000.0


def get_customer(customer_name: str | None) -> dict | None:
    # A genuine "no customer named at all" request (e.g. an implicit
    # reference intent_agent couldn't resolve to a name) — same honest
    # None-in-None-out contract get_product() already has, not an error.
    if customer_name is None:
        return None

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


def _next_customer_id(sheet) -> str:
    # Same "max existing numeric suffix" pattern used everywhere else in
    # this codebase (sales_tools._next_id, export_tools, ...) — robust to
    # row deletion, not dependent on row count.
    max_num = 0
    for row in sheet.iter_rows(min_row=2, values_only=True):
        value = row[0]
        if value and str(value).startswith("C"):
            try:
                max_num = max(max_num, int(str(value)[1:]))
            except ValueError:
                pass
    return f"C{max_num + 1:03d}"


# Auto-provisioning a new customer (agreed with the user): every request
# that names a customer with no existing record gets one created on the
# spot — active, with the flat starter credit limit above — rather than
# dead-ending the request. This is the ONE place a Customer Master row
# gets created outside the original seed data, so it's the one place
# that decision needs explaining, not silently guessed at downstream.
#
# Phase 2: this used to be unlocked AND unconditional. context_agent does
# get_customer() -> create_customer() with nothing between them, so two
# concurrent requests naming the same new customer both missed, and both
# appended: duplicate Customer Master rows (with the same max+1 id, since
# the id scan was unlocked too), plus a whole-workbook rewrite that could
# drop a concurrent writer's row. Now the existence check and the append
# are one critical section, and an EXACT (case-insensitive) name match
# returns the existing customer instead of creating another. The return
# shape is unchanged.
def create_customer(customer_name: str) -> dict:
    if postgres_customer_authority_enabled():
        return _create_customer_postgres_first(customer_name)
    return _create_customer_excel(customer_name)


@read_lock()
def _excel_customer_snapshot(customer_name: str) -> tuple[dict | None, int]:
    """(existing customer by exact case-insensitive name or None, highest C### in Excel)."""
    wb = openpyxl.load_workbook(MOCK_ERP_PATH, read_only=True)
    try:
        wanted = (customer_name or "").strip().lower()
        max_num, found = 0, None
        for cid, name, active, credit_limit in wb["Customer Master"].iter_rows(min_row=2, values_only=True):
            if cid and str(cid).startswith("C") and str(cid)[1:].isdigit():
                max_num = max(max_num, int(str(cid)[1:]))
            if found is None and name and wanted and str(name).strip().lower() == wanted:
                found = {"customer_id": cid, "customer_name": name, "active": bool(active), "credit_limit": credit_limit}
        return found, max_num
    finally:
        wb.close()


# POSTGRES_CUSTOMER_AUTHORITY on: PostgreSQL creates the customer first (id
# from its CUSTOMER sequence, remembered per normalised name so a retry gets
# the same id; credit terms stored there), Excel Customer Master is projected
# from it. Unlike the other creators this has no `created` flag in its return
# contract, so an unavailable Postgres raises (fail closed) instead of
# inventing an Excel-only customer that Postgres has never heard of.
def _create_customer_postgres_first(customer_name: str) -> dict:
    existing, excel_max = _excel_customer_snapshot(customer_name)
    if existing is not None:
        return existing
    try:
        number = allocate_document_number("CUSTOMER", excel_max, idempotency_key=f"customer:{(customer_name or '').strip().lower()}")
        row = find_or_create_customer_sync(
            customer_name, external_customer_id=f"C{number:03d}",
            credit_limit=NEW_CUSTOMER_STARTER_CREDIT_LIMIT, active=True,
        )
    except Exception as exc:
        logger.warning("Postgres customer authority unavailable", exc_info=True)
        raise RuntimeError(f"Postgres customer authority unavailable: {exc}") from exc
    customer_id = row.get("externalCustomerId") or f"C{number:03d}"
    result = {
        "customer_id": customer_id,
        "customer_name": customer_name,
        "active": bool(row.get("active", True)),
        "credit_limit": row.get("creditLimit") if row.get("creditLimit") is not None else NEW_CUSTOMER_STARTER_CREDIT_LIMIT,
    }
    _project_customer_to_excel(result)
    return result


@idempotency_lock()
def _project_customer_to_excel(result: dict) -> bool:
    """Write the Excel projection of a customer that already exists in
    Postgres. Idempotent by id and by name; a failure is logged, never raised —
    the authoritative record exists and the reconciler (postgres_to_excel)
    repairs a missed projection."""
    try:
        wb = openpyxl.load_workbook(MOCK_ERP_PATH)
        sheet = wb["Customer Master"]
        wanted = result["customer_name"].strip().lower()
        for cid, name, _a, _c in sheet.iter_rows(min_row=2, values_only=True):
            if cid == result["customer_id"] or (name and str(name).strip().lower() == wanted):
                return True
        sheet.append([result["customer_id"], result["customer_name"], result["active"], result["credit_limit"]])
        save_workbook(wb)
        record_audit_event(
            "Customer", result["customer_id"], "CUSTOMER_AUTO_PROVISIONED",
            {"customer_name": result["customer_name"], "starter_credit_limit": result["credit_limit"]},
        )
        return True
    except Exception:
        logger.warning("Excel projection of customer %s failed; it exists in Postgres", result["customer_id"], exc_info=True)
        return False


@idempotency_lock()
def _create_customer_excel(customer_name: str) -> dict:
    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    sheet = wb["Customer Master"]
    wanted = (customer_name or "").strip().lower()
    for cid, name, active, credit_limit in sheet.iter_rows(min_row=2, values_only=True):
        if name and wanted and str(name).strip().lower() == wanted:
            return {"customer_id": cid, "customer_name": name, "active": bool(active), "credit_limit": credit_limit}
    customer_id = _next_customer_id(sheet)
    sheet.append([customer_id, customer_name, True, NEW_CUSTOMER_STARTER_CREDIT_LIMIT])
    save_workbook(wb)

    record_audit_event(
        "Customer", customer_id, "CUSTOMER_AUTO_PROVISIONED",
        {"customer_name": customer_name, "starter_credit_limit": NEW_CUSTOMER_STARTER_CREDIT_LIMIT},
    )

    return {
        "customer_id": customer_id,
        "customer_name": customer_name,
        "active": True,
        "credit_limit": NEW_CUSTOMER_STARTER_CREDIT_LIMIT,
    }


def list_customers() -> list[dict]:
    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    sheet = wb["Customer Master"]
    return [
        {"customer_id": customer_id, "customer_name": name, "active": bool(active), "credit_limit": credit_limit}
        for customer_id, name, active, credit_limit in sheet.iter_rows(min_row=2, values_only=True)
    ]
