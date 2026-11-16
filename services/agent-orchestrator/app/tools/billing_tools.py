# app/tools/billing_tools.py
import datetime
import logging
import openpyxl

from app.integrations.order_domain import (
    allocate_document_number,
    dual_write_invoice,
    postgres_invoice_id_authority_enabled,
    sync_invoice_status_paid,
)
from app.tools.idempotency_tools import get_idempotent_result, idempotency_lock, read_lock, record_idempotent_result, stage_idempotent_result
from app.tools.idempotency_tools import save_workbook

MOCK_ERP_PATH = "mock_erp.xlsx"

logger = logging.getLogger(__name__)

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


def _max_invoice_number(sheet) -> int:
    max_num = 0
    for row in sheet.iter_rows(min_row=2, values_only=True):
        value = row[0]
        if value and str(value).startswith("INV"):
            try:
                max_num = max(max_num, int(str(value)[3:]))
            except ValueError:
                pass
    return max_num


@read_lock()
def _prepare_postgres_invoice_id(idempotency_key: str | None) -> tuple[dict | None, int]:
    """(cached result for this key if any, highest INV number in Excel)."""
    cached = get_idempotent_result(idempotency_key, "create_invoice")
    if cached is not None:
        return cached, 0
    wb = openpyxl.load_workbook(MOCK_ERP_PATH, read_only=True)
    try:
        if "Invoices" not in wb.sheetnames:
            return None, 0
        return None, _max_invoice_number(wb["Invoices"])
    finally:
        wb.close()


# Independent-audit fix (lock-blocking, confirmed before fixing — see
# order_domain's retry policy): this used to be one @idempotency_lock()
# function, so the Postgres dual-write below — now carrying up to ~47s of
# retry/backoff when order-service is slow or down — ran WHILE holding
# the single global Excel lock every other write in this codebase
# contends for. An order-service outage would stall financial approvals,
# stock reservations, and every other Excel write app-wide for the full
# retry duration. Split in two: _create_invoice_excel does the entire
# cache-check -> validate -> write -> record-result sequence under the
# lock (unchanged, still atomic, still the only place that can create a
# real Invoice row for a given key — two concurrent callers with the same
# key still can't both write), and releases it before create_invoice
# (this function, NOT lock-decorated) ever touches the network.
#
# The dual-write is attempted on EVERY call, not just a fresh creation —
# including a cache-hit replay — specifically so a genuine retry with the
# same key gets a real chance to recover from a PRIOR failed mirror
# attempt. Safe to repeat: dual_write_invoice upserts on
# external_invoice_id, so retrying it never creates a second Postgres
# row, no matter how many times this is called with the same key.
#
# postgres_synced on the returned result makes "the real Invoice exists"
# (always true when created=True) and "Postgres has it too" explicit and
# separate — Excel and Postgres are never claimed to be atomic; this is
# the caller-visible signal that the mirror may still be behind.
def create_invoice(
    sales_order_id: str,
    delivery_id: str,
    customer_id: str | None,
    customer_name: str | None,
    quantity_billed: int,
    unit_price: float,
    payment_terms_days: int,
    notes: str,
    idempotency_key: str | None = None,
) -> dict:
    if postgres_invoice_id_authority_enabled():
        # PostgreSQL is the authoritative first writer; Excel is a projection.
        return _create_invoice_postgres_first(
            sales_order_id, delivery_id, customer_id, customer_name,
            quantity_billed, unit_price, payment_terms_days, notes, idempotency_key,
        )

    outcome = _create_invoice_excel(
        sales_order_id, delivery_id, customer_id, customer_name,
        quantity_billed, unit_price, payment_terms_days, notes,
        idempotency_key=idempotency_key,
    )
    if not outcome["created"]:
        return outcome

    try:
        dual_write_invoice(
            external_invoice_id=outcome["invoice_id"],
            external_sales_order_id=sales_order_id,
            external_delivery_id=delivery_id,
            customer_id=customer_id,
            customer_name=customer_name,
            quantity_billed=quantity_billed,
            unit_price=unit_price,
            invoice_amount=outcome["invoice_amount"],
            payment_terms_days=payment_terms_days,
            due_date=outcome["due_date"],
            status=outcome["status"],
            notes=notes,
        )
        synced = True
    except Exception:
        # Recovery note, made explicit since not every caller threads an
        # idempotency_key (project_tools.py/service_tools.py's billing
        # call sites don't) — without one, calling create_invoice() again
        # is NOT a safe retry, it creates a second real Excel row. The
        # only safe recovery for a keyless call is retrying the mirror
        # directly: dual_write_invoice(external_invoice_id=invoice_id, ...)
        # with this exact invoice's already-written data — never
        # create_invoice() again.
        recovery_hint = (
            f"retry create_invoice with idempotency_key={idempotency_key!r} to attempt the mirror again"
            if idempotency_key
            else "no idempotency_key was given for this call — do NOT call create_invoice() again to retry; "
            "call dual_write_invoice directly with this invoice's already-written data instead"
        )
        logger.warning(
            "Failed to dual-write Invoice %s to Postgres — mock-ERP row is unaffected; %s.",
            outcome["invoice_id"], recovery_hint, exc_info=True,
        )
        synced = False

    return {**outcome, "postgres_synced": synced}


# POSTGRES_INVOICE_ID_AUTHORITY on: same contract as
# delivery_tools._create_delivery_postgres_first — Postgres id and row first
# (replayed per idempotency key), Excel projection second, fail closed when
# Postgres is unavailable, a failed projection is reported (excel_projected)
# and repaired by retry or the reconciler without losing or duplicating the
# invoice.
def _create_invoice_postgres_first(
    sales_order_id, delivery_id, customer_id, customer_name, quantity_billed, unit_price, payment_terms_days, notes, idempotency_key,
) -> dict:
    if quantity_billed is None or quantity_billed <= 0 or unit_price is None:
        return {"created": False, "reason": "Cannot create an invoice without a valid billed quantity and unit price."}

    cached, excel_max = _prepare_postgres_invoice_id(idempotency_key)
    if cached is not None:
        return {**cached, "postgres_synced": True, "excel_projected": True}

    invoice_amount = round(unit_price * quantity_billed, 2)
    try:
        invoice_id = f"INV{allocate_document_number('INVOICE', excel_max, idempotency_key=idempotency_key):04d}"
        row = dual_write_invoice(
            external_invoice_id=invoice_id,
            external_sales_order_id=sales_order_id,
            external_delivery_id=delivery_id,
            customer_id=customer_id,
            customer_name=customer_name,
            quantity_billed=quantity_billed,
            unit_price=unit_price,
            invoice_amount=invoice_amount,
            payment_terms_days=payment_terms_days,
            due_date=(datetime.date.today() + datetime.timedelta(days=payment_terms_days)).isoformat(),
            status="ISSUED",
            notes=notes,
            idempotency_key=f"invoice:{idempotency_key}" if idempotency_key else None,
        )
    except Exception as exc:
        logger.warning("Postgres id authority unavailable for create_invoice", exc_info=True)
        return {"created": False, "reason": f"Postgres id authority unavailable: {exc}"}

    result = {
        "created": True,
        "invoice_id": invoice_id,
        "invoice_amount": row.get("invoiceAmount", invoice_amount),
        "due_date": (row.get("dueDate") or "")[:10] or None,
        "status": row.get("status") or "ISSUED",
    }
    projected = _project_invoice_to_excel(
        result, sales_order_id, delivery_id, customer_id, customer_name, quantity_billed, unit_price, payment_terms_days, notes, idempotency_key,
    )
    return {**result, "postgres_synced": True, "excel_projected": projected}


@idempotency_lock()
def _project_invoice_to_excel(
    result: dict, sales_order_id, delivery_id, customer_id, customer_name, quantity_billed, unit_price, payment_terms_days, notes, idempotency_key,
) -> bool:
    try:
        wb = openpyxl.load_workbook(MOCK_ERP_PATH)
        sheet = _invoices_sheet(wb)
        for row in sheet.iter_rows(min_row=2, values_only=True):
            if row[0] != result["invoice_id"]:
                continue
            existing = dict(zip(INVOICE_HEADERS, row))
            if (existing["sales_order_id"], existing["delivery_id"], existing["quantity_billed"], existing["unit_price"]) != (
                sales_order_id, delivery_id, quantity_billed, unit_price,
            ):
                logger.error("Excel already holds %s with different content; not overwriting — reconcile", result["invoice_id"])
                return False
            if idempotency_key and get_idempotent_result(idempotency_key, "create_invoice") is None:
                stage_idempotent_result(wb, idempotency_key, "create_invoice", result)
                save_workbook(wb)
            return True
        sheet.append([
            result["invoice_id"], sales_order_id, delivery_id, customer_id, customer_name, quantity_billed, unit_price,
            result["invoice_amount"], payment_terms_days, result["due_date"], result["status"], notes,
            datetime.datetime.now().isoformat(),
        ])
        stage_idempotent_result(wb, idempotency_key, "create_invoice", result)
        save_workbook(wb)  # row + idempotency key in ONE save
        return True
    except Exception:
        logger.warning("Excel projection of invoice %s failed; it exists in Postgres and will be re-projected on retry/reconcile",
                       result["invoice_id"], exc_info=True)
        return False


@idempotency_lock()
def _create_invoice_excel(
    sales_order_id: str,
    delivery_id: str,
    customer_id: str | None,
    customer_name: str | None,
    quantity_billed: int,
    unit_price: float,
    payment_terms_days: int,
    notes: str,
    idempotency_key: str | None = None,
) -> dict:
    cached = get_idempotent_result(idempotency_key, "create_invoice")
    if cached is not None:
        return cached

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
    result = {
        "created": True,
        "invoice_id": invoice_id,
        "invoice_amount": invoice_amount,
        "due_date": due_date,
        "status": status,
    }
    stage_idempotent_result(wb, idempotency_key, "create_invoice", result)
    save_workbook(wb)
    return result


# Newest first, same convention as every other channel's list_*() —
# the "Cash" half of Order-to-Cash finally gets a real, browsable view
# instead of only ever flashing inside one Agent Console chat session.
@read_lock()
def list_invoices() -> list[dict]:
    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    if "Invoices" not in wb.sheetnames:
        return []
    sheet = wb["Invoices"]
    rows = [dict(zip(INVOICE_HEADERS, row)) for row in sheet.iter_rows(min_row=2, values_only=True)]
    rows.reverse()
    return rows


@read_lock()
def find_invoice(invoice_id: str) -> dict | None:
    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    if "Invoices" not in wb.sheetnames:
        return None
    sheet = wb["Invoices"]
    for row in sheet.iter_rows(min_row=2, values_only=True):
        if row[0] == invoice_id:
            return dict(zip(INVOICE_HEADERS, row))
    return None


@read_lock()
def find_invoice_by_sales_order(sales_order_id: str) -> dict | None:
    """Used by the Track Order panel — a sales order only ever gets one
    invoice in this system today (no partial/multi-invoice billing), so
    the most recent match is the real, only match."""
    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    if "Invoices" not in wb.sheetnames:
        return None
    sheet = wb["Invoices"]
    for row in reversed(list(sheet.iter_rows(min_row=2, values_only=True))):
        if row[1] == sales_order_id:
            return dict(zip(INVOICE_HEADERS, row))
    return None


# The first real payment-tracking capability in this system — every
# credit-exposure/billing comment up to now has explicitly flagged "no
# payment tracking yet" as a known gap. Added narrowly here because
# Export's own pipeline explicitly ends in "Payment Realisation -> Closed"
# and needs a real signal to close against, not because every invoice
# flow elsewhere is being retrofitted with payment reconciliation now.
def mark_invoice_paid(invoice_id: str) -> dict:
    """Phase 2 fixes, found by inspection: (1) this used to load the whole
    workbook and save it back with NO lock — a concurrent writer's row
    between load and save was silently overwritten (lost update), and two
    concurrent callers could both pass the ISSUED check; (2) the PAID
    transition was never mirrored to Postgres, so every paid invoice stayed
    ISSUED there. Same split as create_invoice: the Excel check-and-write
    runs under the lock; the network call runs after it is released, and a
    mirror failure is reported (postgres_synced=False), never hidden —
    mark_invoice_paid is safely repeatable, and docs/RECONCILIATION.md
    describes the reconciler that repairs a missed mirror."""
    if postgres_invoice_id_authority_enabled():
        return _mark_invoice_paid_postgres_first(invoice_id)

    outcome = _mark_invoice_paid_excel(invoice_id)
    if not outcome["updated"] and not outcome.get("already_paid"):
        return outcome
    try:
        sync_invoice_status_paid(invoice_id)
        synced = True
    except Exception:
        logger.warning(
            "Failed to mirror PAID status for invoice %s to Postgres — the Excel row is already PAID; "
            "run the post-sales reconciler or call mark_invoice_paid again.", invoice_id, exc_info=True,
        )
        synced = False
    return {**outcome, "postgres_synced": synced}


def _mark_invoice_paid_postgres_first(invoice_id: str) -> dict:
    """PostgreSQL decides first: the atomic ISSUED->PAID compare-and-set runs
    there, then Excel is projected. An invoice that predates Postgres authority
    (404 there) is backfilled from its Excel row once, then transitioned."""
    import httpx

    try:
        try:
            sync_invoice_status_paid(invoice_id)
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 409:
                return {"updated": False, "reason": f"Cannot mark {invoice_id} paid: Postgres reports an illegal transition ({exc.response.text[:120]})."}
            if exc.response.status_code != 404:
                raise
            legacy = find_invoice(invoice_id)
            if legacy is None:
                return {"updated": False, "reason": f"No invoice found with id {invoice_id}"}
            dual_write_invoice(
                external_invoice_id=invoice_id,
                external_sales_order_id=legacy["sales_order_id"], external_delivery_id=legacy["delivery_id"],
                customer_id=legacy["customer_id"], customer_name=legacy["customer_name"],
                quantity_billed=legacy["quantity_billed"], unit_price=legacy["unit_price"],
                invoice_amount=legacy["invoice_amount"], payment_terms_days=legacy["payment_terms_days"],
                due_date=legacy["due_date"], status="ISSUED" if legacy["status"] == "PAID" else legacy["status"], notes=legacy["notes"],
            )
            sync_invoice_status_paid(invoice_id)
    except Exception as exc:
        logger.warning("Postgres id authority unavailable for mark_invoice_paid", exc_info=True)
        return {"updated": False, "reason": f"Postgres id authority unavailable: {exc}"}

    try:
        outcome = _mark_invoice_paid_excel(invoice_id)
        projected = bool(outcome.get("updated") or outcome.get("already_paid"))
    except Exception:
        # Postgres has already decided (PAID); a failed projection must not
        # turn that into an error. A repeat call re-projects.
        logger.warning("Excel projection of PAID for %s failed; Postgres is PAID", invoice_id, exc_info=True)
        projected = False
    return {
        "updated": True, "invoice_id": invoice_id, "status": "PAID",
        "postgres_synced": True, "excel_projected": projected,
    }


@idempotency_lock()
def _mark_invoice_paid_excel(invoice_id: str) -> dict:
    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    if "Invoices" not in wb.sheetnames:
        return {"updated": False, "reason": f"No invoice found with id {invoice_id}"}
    sheet = wb["Invoices"]
    status_col = INVOICE_HEADERS.index("status") + 1

    for row_idx, row in enumerate(sheet.iter_rows(min_row=2), start=2):
        if row[0].value != invoice_id:
            continue
        current_status = row[status_col - 1].value
        if current_status == "PAID":
            # A repeat of an already-applied transition: the Excel side is
            # already correct, but the Postgres mirror may not be (a prior
            # attempt's mirror call may have failed) — let the caller retry it.
            # Legacy contract preserved: callers (routers/channels.py,
            # export_tools.py) read result["reason"] whenever updated is
            # False, so reason stays present; already_paid is additive.
            return {
                "updated": False,
                "already_paid": True,
                "invoice_id": invoice_id,
                "reason": f"Cannot mark {invoice_id} paid from status PAID (expected ISSUED).",
            }
        if current_status != "ISSUED":
            return {
                "updated": False,
                "reason": f"Cannot mark {invoice_id} paid from status {current_status} (expected ISSUED).",
            }
        sheet.cell(row=row_idx, column=status_col, value="PAID")
        save_workbook(wb)
        return {"updated": True, "invoice_id": invoice_id, "status": "PAID"}

    return {"updated": False, "reason": f"No invoice found with id {invoice_id}"}
