# app/tools/delivery_tools.py
import datetime
import logging
import openpyxl

from app.integrations.order_domain import allocate_document_number, dual_write_delivery, postgres_id_authority_enabled
from app.tools.idempotency_tools import get_idempotent_result, idempotency_lock, read_lock, record_idempotent_result, stage_idempotent_result
from app.tools.idempotency_tools import save_workbook

MOCK_ERP_PATH = "mock_erp.xlsx"

logger = logging.getLogger(__name__)

# Real SD behavior (agreed with the user): even a fully in-stock order
# gets a real delivery schedule — loading + transit time — not an
# instant "shipped right now." Deliberately not itself a scheduling
# engine (no capacity/route optimization) — a flat, documented lead
# time, same category of simplification as production_tools.py's
# compute_target_completion_date().
DELIVERY_LEAD_TIME_DAYS = 2

DELIVERY_HEADERS = [
    "delivery_id",
    "sales_order_id",
    "customer_id",
    "customer_name",
    "product_id",
    "product_name",
    "quantity",
    "status",
    "requested_delivery_date",
    "confirmed_delivery_date",
    "created_at",
]


def compute_confirmed_delivery_date(requested_delivery_date: str | None = None) -> str:
    """The confirmed date is never earlier than what loading+transit
    allows, but honors a later customer-requested date if one was
    given — the same real-world constraint a delivery schedule line
    actually has (can't promise sooner than logistics allows, can
    always promise the customer's own later date)."""
    earliest = datetime.date.today() + datetime.timedelta(days=DELIVERY_LEAD_TIME_DAYS)
    if requested_delivery_date:
        try:
            requested = datetime.date.fromisoformat(requested_delivery_date[:10])
            if requested > earliest:
                return requested.isoformat()
        except ValueError:
            pass
    return earliest.isoformat()


def _deliveries_sheet(wb):
    if "Deliveries" not in wb.sheetnames:
        sheet = wb.create_sheet("Deliveries")
        sheet.append(DELIVERY_HEADERS)
        return sheet
    return wb["Deliveries"]


def _next_delivery_id(sheet) -> str:
    max_num = 0
    for row in sheet.iter_rows(min_row=2, values_only=True):
        value = row[0]
        if value and str(value).startswith("DEL"):
            try:
                max_num = max(max_num, int(str(value)[3:]))
            except ValueError:
                pass
    return f"DEL{max_num + 1:04d}"


def _max_delivery_number(sheet) -> int:
    max_num = 0
    for row in sheet.iter_rows(min_row=2, values_only=True):
        value = row[0]
        if value and str(value).startswith("DEL"):
            try:
                max_num = max(max_num, int(str(value)[3:]))
            except ValueError:
                pass
    return max_num


@read_lock()
def _prepare_postgres_id(idempotency_key: str | None) -> tuple[dict | None, int]:
    """(cached result for this key if any, highest DEL number in Excel)."""
    cached = get_idempotent_result(idempotency_key, "create_delivery")
    if cached is not None:
        return cached, 0
    wb = openpyxl.load_workbook(MOCK_ERP_PATH, read_only=True)
    try:
        if "Deliveries" not in wb.sheetnames:
            return None, 0
        return None, _max_delivery_number(wb["Deliveries"])
    finally:
        wb.close()


@read_lock()
def find_delivery_by_sales_order(sales_order_id: str) -> dict | None:
    """Used by the Track Order panel — same one-delivery-per-order
    assumption as find_invoice_by_sales_order (HYBRID's stock leg and
    production leg are two separate sales-order-level deliveries only in
    the sense that each is its own _deliver_and_bill call; today neither
    path creates more than one delivery per call)."""
    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    if "Deliveries" not in wb.sheetnames:
        return None
    sheet = wb["Deliveries"]
    for row in reversed(list(sheet.iter_rows(min_row=2, values_only=True))):
        if row[1] == sales_order_id:
            return dict(zip(DELIVERY_HEADERS, row))
    return None


# Independent-audit fix (lock-blocking) — same split and same reasoning
# as billing_tools.create_invoice/_create_invoice_excel: the Postgres
# dual-write (now carrying up to ~47s of retry/backoff when order-service
# is slow or down) used to run while holding the single global Excel
# lock every other write in this codebase contends for. _create_delivery_excel
# does the entire cache-check -> validate -> write -> record-result
# sequence under the lock (unchanged, still atomic — two concurrent
# callers with the same key still can't both write); create_delivery
# (this function, NOT lock-decorated) releases it before ever touching
# the network.
#
# The dual-write is attempted on EVERY call, including a cache-hit
# replay, so a genuine retry with the same key gets a real chance to
# recover from a prior failed mirror attempt — safe to repeat, since
# dual_write_delivery upserts on external_delivery_id.
#
# postgres_synced on the returned result makes "the real Delivery
# exists" (always true when created=True) and "Postgres has it too"
# explicit and separate — Excel and Postgres are never claimed atomic.
def create_delivery(
    sales_order_id: str,
    customer_id: str | None,
    customer_name: str | None,
    product_id: str,
    product_name: str,
    quantity: int,
    requested_delivery_date: str | None = None,
    idempotency_key: str | None = None,
) -> dict:
    if postgres_id_authority_enabled():
        # PostgreSQL is the authoritative first writer: id and row are created
        # there, Excel is a projection of it (see _create_delivery_postgres_first).
        return _create_delivery_postgres_first(
            sales_order_id, customer_id, customer_name, product_id, product_name, quantity,
            requested_delivery_date, idempotency_key,
        )

    outcome = _create_delivery_excel(
        sales_order_id, customer_id, customer_name, product_id, product_name, quantity,
        requested_delivery_date, idempotency_key=idempotency_key,
    )
    if not outcome["created"]:
        return outcome

    try:
        dual_write_delivery(
            external_delivery_id=outcome["delivery_id"],
            external_sales_order_id=sales_order_id,
            customer_id=customer_id,
            customer_name=customer_name,
            product_id=product_id,
            product_name=product_name,
            quantity=quantity,
            status=outcome["status"],
            requested_delivery_date=requested_delivery_date,
            confirmed_delivery_date=outcome["confirmed_delivery_date"],
        )
        synced = True
    except Exception:
        # Recovery note — same reasoning as billing_tools.create_invoice's
        # own: without a real idempotency_key, calling create_delivery()
        # again is NOT a safe retry (it creates a second real Excel row).
        recovery_hint = (
            f"retry create_delivery with idempotency_key={idempotency_key!r} to attempt the mirror again"
            if idempotency_key
            else "no idempotency_key was given for this call — do NOT call create_delivery() again to retry; "
            "call dual_write_delivery directly with this delivery's already-written data instead"
        )
        logger.warning(
            "Failed to dual-write Delivery %s to Postgres — mock-ERP row is unaffected; %s.",
            outcome["delivery_id"], recovery_hint, exc_info=True,
        )
        synced = False

    return {**outcome, "postgres_synced": synced}


# --------------------------------------------------------------------------
# POSTGRES_ID_AUTHORITY on: PostgreSQL is the authoritative FIRST writer.
#   validate -> id from Postgres (remembered per idempotency key)
#            -> Postgres row (idempotent: replayed for the same key)
#            -> Excel projection (locked; row + idempotency key in one save).
# Failure semantics:
#   * Postgres unavailable / rejects  -> {"created": False}; nothing in Excel,
#     nothing to clean up, the same key retries cleanly.
#   * Postgres ok, Excel write fails  -> the business record EXISTS (it is in
#     Postgres); the result says created=True, excel_projected=False. A retry
#     with the same key gets the same id, the same stored Postgres row, and
#     completes the projection; the reconciler (postgres_to_excel) repairs it
#     otherwise. Nothing is lost and nothing can be duplicated.
# --------------------------------------------------------------------------
def _create_delivery_postgres_first(
    sales_order_id, customer_id, customer_name, product_id, product_name, quantity, requested_delivery_date, idempotency_key,
) -> dict:
    if quantity is None or quantity <= 0:
        return {"created": False, "reason": "Cannot create a delivery for zero or negative quantity."}

    cached, excel_max = _prepare_postgres_id(idempotency_key)
    if cached is not None:
        return {**cached, "postgres_synced": True, "excel_projected": True}

    try:
        delivery_id = f"DEL{allocate_document_number('DELIVERY', excel_max, idempotency_key=idempotency_key):04d}"
        row = dual_write_delivery(
            external_delivery_id=delivery_id,
            external_sales_order_id=sales_order_id,
            customer_id=customer_id,
            customer_name=customer_name,
            product_id=product_id,
            product_name=product_name,
            quantity=quantity,
            status="DISPATCHED",
            requested_delivery_date=requested_delivery_date,
            confirmed_delivery_date=compute_confirmed_delivery_date(requested_delivery_date),
            idempotency_key=f"delivery:{idempotency_key}" if idempotency_key else None,
        )
    except Exception as exc:
        # Fail closed: no Excel-minted fallback id (the id spaces would collide).
        logger.warning("Postgres id authority unavailable for create_delivery", exc_info=True)
        return {"created": False, "reason": f"Postgres id authority unavailable: {exc}"}

    # Values come from the stored Postgres row, not from recomputation, so a
    # retry on a later day still projects exactly what was committed.
    result = {
        "created": True,
        "delivery_id": delivery_id,
        "status": row.get("status") or "DISPATCHED",
        "requested_delivery_date": (row.get("requestedDeliveryDate") or "")[:10] or None,
        "confirmed_delivery_date": (row.get("confirmedDeliveryDate") or "")[:10] or None,
    }
    projected = _project_delivery_to_excel(
        result, sales_order_id, customer_id, customer_name, product_id, product_name, quantity, idempotency_key,
    )
    return {**result, "postgres_synced": True, "excel_projected": projected}


@idempotency_lock()
def _project_delivery_to_excel(
    result: dict, sales_order_id, customer_id, customer_name, product_id, product_name, quantity, idempotency_key,
) -> bool:
    """Write (or confirm) the Excel projection of a delivery that already
    exists in Postgres. Never overwrites a different row. Returns whether
    Excel now holds this delivery; a failure is logged, not raised, because
    the authoritative record exists regardless."""
    try:
        wb = openpyxl.load_workbook(MOCK_ERP_PATH)
        sheet = _deliveries_sheet(wb)
        for row in sheet.iter_rows(min_row=2, values_only=True):
            if row[0] != result["delivery_id"]:
                continue
            existing = dict(zip(DELIVERY_HEADERS, row))
            if (existing["sales_order_id"], existing["product_id"], existing["quantity"]) != (sales_order_id, product_id, quantity):
                logger.error("Excel already holds %s with different content; not overwriting — reconcile", result["delivery_id"])
                return False
            if idempotency_key and get_idempotent_result(idempotency_key, "create_delivery") is None:
                stage_idempotent_result(wb, idempotency_key, "create_delivery", result)
                save_workbook(wb)
            return True
        sheet.append([
            result["delivery_id"], sales_order_id, customer_id, customer_name, product_id, product_name, quantity,
            result["status"], result["requested_delivery_date"], result["confirmed_delivery_date"],
            datetime.datetime.now().isoformat(),
        ])
        stage_idempotent_result(wb, idempotency_key, "create_delivery", result)
        save_workbook(wb)  # row + idempotency key in ONE save
        return True
    except Exception:
        logger.warning("Excel projection of delivery %s failed; it exists in Postgres and will be re-projected on retry/reconcile",
                       result["delivery_id"], exc_info=True)
        return False


# Only ever called for a quantity that's actually been reserved from real
# stock — MTS in full, HYBRID's stock leg. MTO/CTO's produced quantity has
# no delivery path yet since nothing is actually finished.
@idempotency_lock()
def _create_delivery_excel(
    sales_order_id: str,
    customer_id: str | None,
    customer_name: str | None,
    product_id: str,
    product_name: str,
    quantity: int,
    requested_delivery_date: str | None = None,
    idempotency_key: str | None = None,
) -> dict:
    cached = get_idempotent_result(idempotency_key, "create_delivery")
    if cached is not None:
        return cached

    if quantity is None or quantity <= 0:
        return {
            "created": False,
            "reason": "Cannot create a delivery for zero or negative quantity.",
        }

    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    sheet = _deliveries_sheet(wb)

    delivery_id = _next_delivery_id(sheet)
    created_at = datetime.datetime.now().isoformat()
    confirmed_delivery_date = compute_confirmed_delivery_date(requested_delivery_date)
    status = "DISPATCHED"

    sheet.append([
        delivery_id,
        sales_order_id,
        customer_id,
        customer_name,
        product_id,
        product_name,
        quantity,
        status,
        requested_delivery_date,
        confirmed_delivery_date,
        created_at,
    ])
    result = {
        "created": True,
        "delivery_id": delivery_id,
        "status": status,
        "requested_delivery_date": requested_delivery_date,
        "confirmed_delivery_date": confirmed_delivery_date,
    }
    stage_idempotent_result(wb, idempotency_key, "create_delivery", result)
    save_workbook(wb)
    return result
