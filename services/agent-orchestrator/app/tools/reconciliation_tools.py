# app/tools/reconciliation_tools.py
"""
Phase 2 (Database Authority): detect — and optionally repair — drift
between the mock-ERP Excel workbook and Postgres for Delivery and Invoice.

Why this exists: Delivery/Invoice are written to Excel first and mirrored to
Postgres best-effort (delivery_tools/billing_tools report postgres_synced).
Nothing ever compared the two, so a failed mirror, or a state change that was
never mirrored (mark_invoice_paid, until this phase), stayed invisible.

Design:
- Report is read-only and never mutates either store.
- Repair is opt-in and only ever re-runs the SAME idempotent upsert the
  original write used (dual_write_delivery / dual_write_invoice /
  sync_invoice_status_paid), so repairing cannot create a duplicate delivery
  or invoice: order-service upserts on (enterpriseId, externalXId).
- Repair copies Excel -> Postgres for rows missing in Postgres or differing
  from Excel. It deliberately does NOT delete or "fix" anything in Excel and
  does NOT touch rows that exist only in Postgres (those are reported as
  missing_in_excel): with Postgres becoming authoritative, a Postgres-only
  row is not evidence of an error, and silently deleting it would be.
"""
import datetime
import logging

import openpyxl

from app.integrations.order_domain import (
    create_sales_order_record_sync,
    dual_write_delivery,
    dual_write_invoice,
    find_or_create_customer_sync,
    list_postgres_customers,
    list_postgres_deliveries_and_invoices,
    list_postgres_sales_orders,
    sync_invoice_status_paid,
)
from app.tools.billing_tools import INVOICE_HEADERS
from app.tools.delivery_tools import DELIVERY_HEADERS
from app.tools.idempotency_tools import idempotency_lock, read_lock, save_workbook
from app.tools.sales_tools import SALES_ORDER_HEADERS

logger = logging.getLogger(__name__)

MOCK_ERP_PATH = "mock_erp.xlsx"


def _rows(sheet_name: str, headers: list[str]) -> dict[str, dict]:
    wb = openpyxl.load_workbook(MOCK_ERP_PATH, read_only=True, data_only=True)
    try:
        if sheet_name not in wb.sheetnames:
            return {}
        out: dict[str, dict] = {}
        for row in wb[sheet_name].iter_rows(min_row=2, values_only=True):
            if not row or not row[0]:
                continue
            out[str(row[0])] = dict(zip(headers, row))
        return out
    finally:
        wb.close()


@read_lock()
def read_excel_post_sales() -> tuple[dict[str, dict], dict[str, dict]]:
    return _rows("Deliveries", DELIVERY_HEADERS), _rows("Invoices", INVOICE_HEADERS)


def _num(v) -> float | None:
    return None if v is None else round(float(v), 6)


def _day(v) -> str | None:
    """Compare dates by calendar day: Excel stores ISO text or datetimes,
    Postgres returns full ISO timestamps for the same instant."""
    if v is None or v == "":
        return None
    if isinstance(v, (datetime.datetime, datetime.date)):
        return v.date().isoformat() if isinstance(v, datetime.datetime) else v.isoformat()
    return str(v)[:10]


def _blank(v):
    return None if v in ("", None) else v


# (label, excel-value-getter, postgres-value-getter) — only fields whose
# value is fixed at creation or has a defined mirror; created_at is excluded
# (each store stamps its own).
_DELIVERY_FIELDS = [
    ("sales_order_id", lambda e: _blank(e["sales_order_id"]), lambda p: _blank(p.get("externalSalesOrderId"))),
    ("customer_id", lambda e: _blank(e["customer_id"]), lambda p: _blank(p.get("customerId"))),
    ("product_id", lambda e: _blank(e["product_id"]), lambda p: _blank(p.get("productId"))),
    ("quantity", lambda e: _num(e["quantity"]), lambda p: _num(p.get("quantity"))),
    ("status", lambda e: _blank(e["status"]), lambda p: _blank(p.get("status"))),
    ("confirmed_delivery_date", lambda e: _day(e["confirmed_delivery_date"]), lambda p: _day(p.get("confirmedDeliveryDate"))),
]
_INVOICE_FIELDS = [
    ("sales_order_id", lambda e: _blank(e["sales_order_id"]), lambda p: _blank(p.get("externalSalesOrderId"))),
    ("delivery_id", lambda e: _blank(e["delivery_id"]), lambda p: _blank(p.get("externalDeliveryId"))),
    ("quantity_billed", lambda e: _num(e["quantity_billed"]), lambda p: _num(p.get("quantityBilled"))),
    ("unit_price", lambda e: _num(e["unit_price"]), lambda p: _num(p.get("unitPrice"))),
    ("invoice_amount", lambda e: _num(e["invoice_amount"]), lambda p: _num(p.get("invoiceAmount"))),
    ("status", lambda e: _blank(e["status"]), lambda p: _blank(p.get("status"))),
]


def _diff(excel: dict[str, dict], pg: dict[str, dict], fields) -> dict:
    mismatched = []
    for key in sorted(set(excel) & set(pg)):
        changed = {}
        for label, get_e, get_p in fields:
            ev, pv = get_e(excel[key]), get_p(pg[key])
            if ev != pv:
                changed[label] = {"excel": ev, "postgres": pv}
        if changed:
            mismatched.append({"id": key, "fields": changed})
    return {
        "excel_count": len(excel),
        "postgres_count": len(pg),
        "missing_in_postgres": sorted(set(excel) - set(pg)),
        "missing_in_excel": sorted(set(pg) - set(excel)),
        "mismatched": mismatched,
    }


def _repair_delivery(e: dict) -> None:
    dual_write_delivery(
        external_delivery_id=str(e["delivery_id"]),
        external_sales_order_id=_blank(e["sales_order_id"]),
        customer_id=_blank(e["customer_id"]),
        customer_name=_blank(e["customer_name"]),
        product_id=_blank(e["product_id"]),
        product_name=_blank(e["product_name"]),
        quantity=e["quantity"],
        status=e["status"],
        requested_delivery_date=_blank(e["requested_delivery_date"]),
        confirmed_delivery_date=_blank(e["confirmed_delivery_date"]),
    )


def _repair_invoice(e: dict) -> None:
    dual_write_invoice(
        external_invoice_id=str(e["invoice_id"]),
        external_sales_order_id=_blank(e["sales_order_id"]),
        external_delivery_id=_blank(e["delivery_id"]),
        customer_id=_blank(e["customer_id"]),
        customer_name=_blank(e["customer_name"]),
        quantity_billed=e["quantity_billed"],
        unit_price=e["unit_price"],
        invoice_amount=e["invoice_amount"],
        payment_terms_days=e["payment_terms_days"],
        due_date=_blank(e["due_date"]),
        status=e["status"],
        notes=_blank(e["notes"]),
    )


def reconcile_post_sales(repair: bool = False, direction: str = "excel_to_postgres", only_ids: set[str] | None = None) -> dict:
    """Compare Excel and Postgres Delivery/Invoice rows. With repair=True,
    re-run the idempotent Postgres upsert for every Excel row that is
    missing from, or differs in, Postgres. Returns the pre-repair findings
    plus what was repaired and what failed — a failed repair is reported,
    never swallowed, and leaves the finding in place for the next run."""
    excel_deliveries, excel_invoices = read_excel_post_sales()
    pg_deliveries, pg_invoices = list_postgres_deliveries_and_invoices()

    deliveries = _diff(excel_deliveries, pg_deliveries, _DELIVERY_FIELDS)
    invoices = _diff(excel_invoices, pg_invoices, _INVOICE_FIELDS)
    repaired: list[str] = []
    failures: list[dict] = []

    if repair and direction == "postgres_to_excel":
        _repair_post_sales_into_excel(deliveries, invoices, pg_deliveries, pg_invoices, repaired, failures, only_ids)
    elif repair:
        todo_d = deliveries["missing_in_postgres"] + [m["id"] for m in deliveries["mismatched"]]
        todo_i = invoices["missing_in_postgres"] + [m["id"] for m in invoices["mismatched"]]
        for key in todo_d:
            try:
                _repair_delivery(excel_deliveries[key])
                repaired.append(key)
            except Exception as exc:
                logger.warning("Reconcile repair failed for delivery %s", key, exc_info=True)
                failures.append({"id": key, "error": str(exc)})
        for key in todo_i:
            # Never regress Postgres: a PAID invoice in Postgres whose Excel
            # row still says ISSUED means Excel is the stale side (e.g. the
            # workbook was restored from a backup). Overwriting Postgres from
            # it would un-pay an invoice, so that case is reported only.
            if key in pg_invoices and pg_invoices[key].get("status") == "PAID" and excel_invoices[key]["status"] != "PAID":
                failures.append({"id": key, "error": "Postgres is ahead (PAID) of Excel; not regressing it — repair Excel manually"})
                continue
            try:
                _repair_invoice(excel_invoices[key])
                # dual_write_invoice's upsert carries status too, but an
                # already-PAID Excel row is re-asserted through the CAS
                # endpoint as well so the mirror path itself is exercised.
                if excel_invoices[key]["status"] == "PAID":
                    sync_invoice_status_paid(key)
                repaired.append(key)
            except Exception as exc:
                logger.warning("Reconcile repair failed for invoice %s", key, exc_info=True)
                failures.append({"id": key, "error": str(exc)})

    consistent = not (
        deliveries["missing_in_postgres"] or deliveries["mismatched"]
        or invoices["missing_in_postgres"] or invoices["mismatched"]
    )
    return {
        "consistent": consistent,
        "deliveries": deliveries,
        "invoices": invoices,
        "repair_requested": repair,
        "direction": direction,
        "repaired": repaired,
        "repair_failures": failures,
    }



# ---------------------------------------------------------------------------
# PostgreSQL -> Excel (Postgres authoritative, Excel a projection)
# ---------------------------------------------------------------------------
def _day_or_none(v) -> str | None:
    return (str(v)[:10] or None) if v else None


@idempotency_lock()
def _project_rows_into_excel(sheet_name: str, headers: list[str], rows: list[list], overwrite_fields: dict[str, dict] | None = None) -> None:
    """Append rows whose id is absent, and overwrite named fields of rows that
    exist, in ONE locked load/save. Never deletes anything."""
    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    sheet = wb[sheet_name] if sheet_name in wb.sheetnames else wb.create_sheet(sheet_name)
    if sheet.max_row == 1 and sheet.cell(row=1, column=1).value is None:
        sheet.append(headers)
    present = {str(r[0].value): idx for idx, r in enumerate(sheet.iter_rows(min_row=2), start=2) if r[0].value}
    for row in rows:
        if str(row[0]) not in present:
            sheet.append(row)
    for ident, fields in (overwrite_fields or {}).items():
        idx = present.get(ident)
        if idx is None:
            continue
        for name, value in fields.items():
            sheet.cell(row=idx, column=headers.index(name) + 1, value=value)
    save_workbook(wb)


def _repair_post_sales_into_excel(deliveries, invoices, pg_deliveries, pg_invoices, repaired, failures, only_ids) -> None:
    def wanted(i):
        return only_ids is None or i in only_ids

    d_rows, i_rows, d_over, i_over = [], [], {}, {}
    for key in deliveries["missing_in_excel"]:
        if wanted(key):
            p = pg_deliveries[key]
            d_rows.append([key, p.get("externalSalesOrderId"), p.get("customerId"), p.get("customerName"), p.get("productId"),
                           p.get("productName"), p.get("quantity"), p.get("status"), _day_or_none(p.get("requestedDeliveryDate")),
                           _day_or_none(p.get("confirmedDeliveryDate")), str(p.get("createdAt") or "")])
    for m in deliveries["mismatched"]:
        if wanted(m["id"]):
            p = pg_deliveries[m["id"]]
            d_over[m["id"]] = {"sales_order_id": p.get("externalSalesOrderId"), "customer_id": p.get("customerId"),
                               "product_id": p.get("productId"), "quantity": p.get("quantity"), "status": p.get("status"),
                               "confirmed_delivery_date": _day_or_none(p.get("confirmedDeliveryDate"))}
    for key in invoices["missing_in_excel"]:
        if wanted(key):
            p = pg_invoices[key]
            i_rows.append([key, p.get("externalSalesOrderId"), p.get("externalDeliveryId"), p.get("customerId"), p.get("customerName"),
                           p.get("quantityBilled"), p.get("unitPrice"), p.get("invoiceAmount"), p.get("paymentTermsDays"),
                           _day_or_none(p.get("dueDate")), p.get("status"), p.get("notes"), str(p.get("createdAt") or "")])
    for m in invoices["mismatched"]:
        if wanted(m["id"]):
            p = pg_invoices[m["id"]]
            i_over[m["id"]] = {"sales_order_id": p.get("externalSalesOrderId"), "delivery_id": p.get("externalDeliveryId"),
                               "quantity_billed": p.get("quantityBilled"), "unit_price": p.get("unitPrice"),
                               "invoice_amount": p.get("invoiceAmount"), "status": p.get("status")}
    try:
        if d_rows or d_over:
            _project_rows_into_excel("Deliveries", DELIVERY_HEADERS, d_rows, d_over)
            repaired.extend([r[0] for r in d_rows] + list(d_over))
        if i_rows or i_over:
            _project_rows_into_excel("Invoices", INVOICE_HEADERS, i_rows, i_over)
            repaired.extend([r[0] for r in i_rows] + list(i_over))
    except Exception as exc:
        logger.warning("Postgres->Excel repair failed", exc_info=True)
        failures.append({"id": "post-sales", "error": str(exc)})


# ---------------------------------------------------------------------------
# Customers and SalesOrders
# ---------------------------------------------------------------------------
CUSTOMER_HEADERS = ["customer_id", "customer_name", "active", "credit_limit"]


@read_lock()
def read_excel_orders() -> tuple[dict[str, dict], dict[str, dict]]:
    return _rows("Customer Master", CUSTOMER_HEADERS), _rows("SalesOrders", SALES_ORDER_HEADERS)


def _norm(v) -> str:
    return (str(v or "")).strip().lower()


def reconcile_orders(repair: bool = False, direction: str = "excel_to_postgres", only_ids: set[str] | None = None) -> dict:
    """Compare Customer Master and SalesOrders between Excel and PostgreSQL.

    Customers are matched by external id (Excel C###); a Postgres customer with
    no external id but the same name is reported as `unlinked_in_postgres`
    (adoptable), not as missing. SalesOrders are matched by externalOrderId and
    compared on value and customer name; STATUS is deliberately not compared
    (Excel keeps channel statuses, Postgres derives its own from fulfillment).
    Rows Postgres holds with no counterpart key (ERP-sourced customers, orders
    of other channels) are counted, not treated as drift."""
    excel_customers, excel_orders = read_excel_orders()
    pg_customers = list_postgres_customers()
    pg_orders = list_postgres_sales_orders()

    pg_c_ext = {c["externalCustomerId"]: c for c in pg_customers.values() if c.get("externalCustomerId")}
    pg_c_name = {_norm(c["name"]): c for c in pg_customers.values() if not c.get("externalCustomerId")}
    c_missing_pg, c_unlinked, c_mismatch = [], [], []
    for cid, e in excel_customers.items():
        p = pg_c_ext.get(cid)
        if p is None:
            (c_unlinked if _norm(e["customer_name"]) in pg_c_name else c_missing_pg).append(cid)
            continue
        changed = {}
        if _norm(p["name"]) != _norm(e["customer_name"]):
            changed["name"] = {"excel": e["customer_name"], "postgres": p["name"]}
        if _num(p.get("creditLimit")) != _num(e["credit_limit"]):
            changed["credit_limit"] = {"excel": _num(e["credit_limit"]), "postgres": _num(p.get("creditLimit"))}
        if bool(p.get("active", True)) != bool(e["active"]):
            changed["active"] = {"excel": bool(e["active"]), "postgres": bool(p.get("active", True))}
        if changed:
            c_mismatch.append({"id": cid, "fields": changed})
    c_missing_excel = sorted(k for k in pg_c_ext if k not in excel_customers)

    pg_o_ext = {o["externalOrderId"]: o for o in pg_orders.values() if o.get("externalOrderId")}
    o_missing_pg, o_mismatch = [], []
    for oid, e in excel_orders.items():
        p = pg_o_ext.get(oid)
        if p is None:
            o_missing_pg.append(oid)
            continue
        changed = {}
        if _num(p.get("value")) != _num(e["total_amount"]):
            changed["value"] = {"excel": _num(e["total_amount"]), "postgres": _num(p.get("value"))}
        pg_name = (p.get("customer") or {}).get("name")
        if _norm(pg_name) != _norm(e["customer_name"]):
            changed["customer_name"] = {"excel": e["customer_name"], "postgres": pg_name}
        if changed:
            o_mismatch.append({"id": oid, "fields": changed})
    o_missing_excel = sorted(k for k in pg_o_ext if k not in excel_orders)

    report = {
        "customers": {
            "excel_count": len(excel_customers), "postgres_count": len(pg_customers),
            "missing_in_postgres": sorted(c_missing_pg), "unlinked_in_postgres": sorted(c_unlinked),
            "missing_in_excel": c_missing_excel, "mismatched": c_mismatch,
            "postgres_without_external_id": sum(1 for c in pg_customers.values() if not c.get("externalCustomerId")),
        },
        "sales_orders": {
            "excel_count": len(excel_orders), "postgres_count": len(pg_orders),
            "missing_in_postgres": sorted(o_missing_pg), "missing_in_excel": o_missing_excel, "mismatched": o_mismatch,
            "postgres_without_external_id": sum(1 for o in pg_orders.values() if not o.get("externalOrderId")),
        },
    }
    report["consistent"] = not (
        c_missing_pg or c_unlinked or c_mismatch or o_missing_pg or o_mismatch
        if direction == "excel_to_postgres"
        else c_missing_excel or c_mismatch or o_missing_excel or o_mismatch
    )
    repaired: list[str] = []
    failures: list[dict] = []

    def wanted(i):
        return only_ids is None or i in only_ids

    if repair and direction == "excel_to_postgres":
        for cid in c_missing_pg + c_unlinked:
            if not wanted(cid):
                continue
            e = excel_customers[cid]
            try:
                find_or_create_customer_sync(e["customer_name"], external_customer_id=cid, credit_limit=_num(e["credit_limit"]), active=bool(e["active"]))
                repaired.append(cid)
            except Exception as exc:
                failures.append({"id": cid, "error": str(exc)})
        for m in c_mismatch:
            failures.append({"id": m["id"], "error": "customer value drift is reported only: adopt-only repair never overwrites Postgres values"})
        for oid in o_missing_pg:
            if not wanted(oid):
                continue
            e = excel_orders[oid]
            try:
                customer = find_or_create_customer_sync(e["customer_name"] or e["customer_id"], external_customer_id=e["customer_id"])
                due = _day_or_none(e["requested_deadline"]) or datetime.date.today().isoformat()
                create_sales_order_record_sync(customer["id"], due, float(e["total_amount"] or 0), oid)
                repaired.append(oid)
            except Exception as exc:
                failures.append({"id": oid, "error": str(exc)})
        for m in o_mismatch:
            failures.append({"id": m["id"], "error": "sales order drift is reported only; Postgres values are never overwritten from Excel"})
    elif repair:
        try:
            c_rows = []
            for cid in c_missing_excel:
                if wanted(cid):
                    p = pg_c_ext[cid]
                    c_rows.append([cid, p["name"], bool(p.get("active", True)), p.get("creditLimit")])
            c_over = {m["id"]: {"customer_name": pg_c_ext[m["id"]]["name"], "active": bool(pg_c_ext[m["id"]].get("active", True)),
                                "credit_limit": pg_c_ext[m["id"]].get("creditLimit")} for m in c_mismatch if wanted(m["id"])}
            if c_rows or c_over:
                _project_rows_into_excel("Customer Master", CUSTOMER_HEADERS, c_rows, c_over)
                repaired.extend([r[0] for r in c_rows] + list(c_over))
            o_rows = []
            for oid in o_missing_excel:
                if wanted(oid):
                    p = pg_o_ext[oid]
                    line = (p.get("orderLines") or [{}])[0]
                    cust = p.get("customer") or {}
                    o_rows.append([oid, cust.get("externalCustomerId"), cust.get("name"), line.get("productId"), line.get("productName"),
                                   line.get("quantity"), line.get("unitPrice"), p.get("value"), _day_or_none(p.get("dueDate")),
                                   "CONFIRMED", str(p.get("createdAt") or "")])
            o_over = {m["id"]: {"total_amount": pg_o_ext[m["id"]].get("value")} for m in o_mismatch if "value" in m["fields"] and wanted(m["id"])}
            if o_rows or o_over:
                _project_rows_into_excel("SalesOrders", SALES_ORDER_HEADERS, o_rows, o_over)
                repaired.extend([r[0] for r in o_rows] + list(o_over))
        except Exception as exc:
            logger.warning("Postgres->Excel orders repair failed", exc_info=True)
            failures.append({"id": "orders", "error": str(exc)})
    report.update({"repair_requested": repair, "direction": direction, "repaired": repaired, "repair_failures": failures})
    return report
