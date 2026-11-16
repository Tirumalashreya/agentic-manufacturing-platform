# Phase 2 (Database Authority): mark_invoice_paid's lock + Postgres mirror, and
# the Excel <-> Postgres reconciler. The Postgres side (order-service) is
# stubbed here — its real behavior (PATCH /invoices/:id/status CAS, GET
# /deliveries|/invoices keyset paging, tenant scoping, 20-way concurrency) is
# proven against real Postgres in order-service/src/app.test.ts. What is
# proven HERE is the Python side: ordering, failure reporting, lock coverage,
# and that repair only re-runs idempotent upserts and never regresses PAID.
import threading
import uuid

import pytest

from app.tools import billing_tools, delivery_tools, reconciliation_tools
from app.tools.billing_tools import create_invoice, mark_invoice_paid


def _new_invoice(monkeypatch, tag: str) -> str:
    monkeypatch.setattr(billing_tools, "dual_write_invoice", lambda **kw: {"ok": True})
    out = create_invoice(
        sales_order_id=f"SO-RECON-{tag}", delivery_id=f"DEL-RECON-{tag}", customer_id="C001", customer_name="ABC Corp",
        quantity_billed=2, unit_price=10.0, payment_terms_days=30, notes="recon test",
        idempotency_key=f"recon-{tag}-{uuid.uuid4()}",
    )
    assert out["created"] is True
    return out["invoice_id"]


def test_mark_paid_mirrors_to_postgres_exactly_once(monkeypatch):
    invoice_id = _new_invoice(monkeypatch, "a")
    calls = []
    monkeypatch.setattr(billing_tools, "sync_invoice_status_paid", lambda iid: calls.append(iid) or {"status": "PAID"})

    result = mark_invoice_paid(invoice_id)

    assert result["updated"] is True and result["status"] == "PAID"
    assert result["postgres_synced"] is True
    assert calls == [invoice_id]


def test_mark_paid_reports_failed_mirror_instead_of_hiding_it(monkeypatch):
    invoice_id = _new_invoice(monkeypatch, "b")

    def boom(_):
        raise RuntimeError("order-service down")

    monkeypatch.setattr(billing_tools, "sync_invoice_status_paid", boom)
    result = mark_invoice_paid(invoice_id)

    # Excel is the committed write; the failed mirror is reported, not swallowed.
    assert result["updated"] is True
    assert result["postgres_synced"] is False


def test_repeat_mark_paid_keeps_legacy_contract_and_retries_the_mirror(monkeypatch):
    invoice_id = _new_invoice(monkeypatch, "c")
    calls = []
    monkeypatch.setattr(billing_tools, "sync_invoice_status_paid", lambda iid: calls.append(iid) or {})

    mark_invoice_paid(invoice_id)
    again = mark_invoice_paid(invoice_id)

    assert again["updated"] is False
    assert again["already_paid"] is True
    assert "reason" in again  # routers/channels.py and export_tools.py read this
    assert calls == [invoice_id, invoice_id]  # a missed mirror gets another chance on retry


def test_mark_paid_unknown_invoice_does_not_touch_postgres(monkeypatch):
    calls = []
    monkeypatch.setattr(billing_tools, "sync_invoice_status_paid", lambda iid: calls.append(iid) or {})
    result = mark_invoice_paid("INV-DOES-NOT-EXIST")
    assert result["updated"] is False and "No invoice found" in result["reason"]
    assert calls == []


def test_concurrent_mark_paid_and_other_writes_lose_nothing(monkeypatch):
    """The pre-fix mark_invoice_paid loaded and saved the whole workbook with
    no lock, so a concurrent writer's row (or another PAID) could be
    overwritten. Run 4 mark-paids and 4 delivery creates at once: all 8
    effects must be present afterwards."""
    ids = [_new_invoice(monkeypatch, f"conc{i}") for i in range(4)]
    monkeypatch.setattr(billing_tools, "sync_invoice_status_paid", lambda iid: {})
    monkeypatch.setattr(delivery_tools, "dual_write_delivery", lambda **kw: {})
    delivery_ids: list[str] = []
    errors: list[Exception] = []

    def pay(i):
        try:
            mark_invoice_paid(i)
        except Exception as exc:  # pragma: no cover - surfaced by the assert below
            errors.append(exc)

    def deliver(n):
        try:
            out = delivery_tools.create_delivery(
                sales_order_id=f"SO-RECON-D{n}", customer_id="C001", customer_name="ABC Corp",
                product_id="P011", product_name="Wireless Mouse", quantity=1,
                idempotency_key=f"recon-del-{uuid.uuid4()}",
            )
            delivery_ids.append(out["delivery_id"])
        except Exception as exc:  # pragma: no cover
            errors.append(exc)

    threads = [threading.Thread(target=pay, args=(i,)) for i in ids] + [threading.Thread(target=deliver, args=(n,)) for n in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors, errors
    excel_deliveries, excel_invoices = reconciliation_tools.read_excel_post_sales()
    assert all(excel_invoices[i]["status"] == "PAID" for i in ids)
    assert len(set(delivery_ids)) == 4 and all(d in excel_deliveries for d in delivery_ids)


# ---------------------------------------------------------------- reconciler

def _excel_delivery(i, qty=5, status="DISPATCHED"):
    return {
        "delivery_id": i, "sales_order_id": "SO-1", "customer_id": "C001", "customer_name": "ABC",
        "product_id": "P011", "product_name": "Mouse", "quantity": qty, "status": status,
        "requested_delivery_date": None, "confirmed_delivery_date": "2026-11-05", "created_at": "x",
    }


def _pg_delivery(i, qty=5, status="DISPATCHED"):
    return {
        "externalDeliveryId": i, "externalSalesOrderId": "SO-1", "customerId": "C001", "productId": "P011",
        "quantity": qty, "status": status, "confirmedDeliveryDate": "2026-11-05T00:00:00.000Z",
    }


def _excel_invoice(i, status="ISSUED", amount=20.0):
    return {
        "invoice_id": i, "sales_order_id": "SO-1", "delivery_id": "DEL9", "customer_id": "C001", "customer_name": "ABC",
        "quantity_billed": 2, "unit_price": 10.0, "invoice_amount": amount, "payment_terms_days": 30,
        "due_date": None, "status": status, "notes": "", "created_at": "x",
    }


def _pg_invoice(i, status="ISSUED", amount=20.0):
    return {
        "externalInvoiceId": i, "externalSalesOrderId": "SO-1", "externalDeliveryId": "DEL9",
        "quantityBilled": 2, "unitPrice": 10.0, "invoiceAmount": amount, "status": status,
    }


@pytest.fixture
def stub_stores(monkeypatch):
    state = {"excel": ({}, {}), "pg": ({}, {}), "upserts": [], "paid_syncs": [], "fail": set()}
    monkeypatch.setattr(reconciliation_tools, "read_excel_post_sales", lambda: state["excel"])
    monkeypatch.setattr(reconciliation_tools, "list_postgres_deliveries_and_invoices", lambda: state["pg"])

    def up_d(**kw):
        if kw["external_delivery_id"] in state["fail"]:
            raise RuntimeError("order-service 503")
        state["upserts"].append(("delivery", kw["external_delivery_id"]))

    def up_i(**kw):
        if kw["external_invoice_id"] in state["fail"]:
            raise RuntimeError("order-service 503")
        state["upserts"].append(("invoice", kw["external_invoice_id"]))

    monkeypatch.setattr(reconciliation_tools, "dual_write_delivery", up_d)
    monkeypatch.setattr(reconciliation_tools, "dual_write_invoice", up_i)
    monkeypatch.setattr(reconciliation_tools, "sync_invoice_status_paid", lambda k: state["paid_syncs"].append(k))
    return state


def test_report_finds_every_kind_of_drift_and_mutates_nothing(stub_stores):
    stub_stores["excel"] = (
        {"DEL1": _excel_delivery("DEL1"), "DEL2": _excel_delivery("DEL2", qty=7), "DEL3": _excel_delivery("DEL3")},
        {"INV1": _excel_invoice("INV1", status="PAID"), "INV2": _excel_invoice("INV2")},
    )
    stub_stores["pg"] = (
        {"DEL1": _pg_delivery("DEL1"), "DEL2": _pg_delivery("DEL2", qty=5), "DEL-PG-ONLY": _pg_delivery("DEL-PG-ONLY")},
        {"INV1": _pg_invoice("INV1", status="ISSUED"), "INV2": _pg_invoice("INV2")},
    )

    report = reconciliation_tools.reconcile_post_sales(repair=False)

    assert report["consistent"] is False
    assert report["deliveries"]["missing_in_postgres"] == ["DEL3"]
    assert report["deliveries"]["missing_in_excel"] == ["DEL-PG-ONLY"]
    assert report["deliveries"]["mismatched"] == [{"id": "DEL2", "fields": {"quantity": {"excel": 7.0, "postgres": 5.0}}}]
    assert report["invoices"]["mismatched"] == [{"id": "INV1", "fields": {"status": {"excel": "PAID", "postgres": "ISSUED"}}}]
    assert stub_stores["upserts"] == [] and stub_stores["paid_syncs"] == []  # a report never repairs


def test_matching_stores_are_consistent_even_with_postgres_only_rows(stub_stores):
    stub_stores["excel"] = ({"DEL1": _excel_delivery("DEL1")}, {"INV1": _excel_invoice("INV1")})
    stub_stores["pg"] = ({"DEL1": _pg_delivery("DEL1"), "DEL-NEW": _pg_delivery("DEL-NEW")}, {"INV1": _pg_invoice("INV1")})
    report = reconciliation_tools.reconcile_post_sales()
    assert report["consistent"] is True  # a Postgres-only row is reported, but is not drift
    assert report["deliveries"]["missing_in_excel"] == ["DEL-NEW"]


def test_repair_reupserts_only_missing_and_mismatched_and_is_idempotent_to_repeat(stub_stores):
    stub_stores["excel"] = (
        {"DEL1": _excel_delivery("DEL1"), "DEL2": _excel_delivery("DEL2", qty=7), "DEL3": _excel_delivery("DEL3")},
        {"INV1": _excel_invoice("INV1", status="PAID")},
    )
    stub_stores["pg"] = ({"DEL1": _pg_delivery("DEL1"), "DEL2": _pg_delivery("DEL2")}, {"INV1": _pg_invoice("INV1")})

    report = reconciliation_tools.reconcile_post_sales(repair=True)

    assert sorted(report["repaired"]) == ["DEL2", "DEL3", "INV1"]
    assert ("delivery", "DEL1") not in stub_stores["upserts"]  # in sync: untouched
    assert stub_stores["paid_syncs"] == ["INV1"]
    assert report["repair_failures"] == []


def test_repair_failure_is_reported_not_swallowed_and_does_not_stop_other_repairs(stub_stores):
    stub_stores["excel"] = ({"DEL1": _excel_delivery("DEL1"), "DEL2": _excel_delivery("DEL2")}, {})
    stub_stores["pg"] = ({}, {})
    stub_stores["fail"] = {"DEL1"}

    report = reconciliation_tools.reconcile_post_sales(repair=True)

    assert report["repaired"] == ["DEL2"]
    assert [f["id"] for f in report["repair_failures"]] == ["DEL1"]
    assert report["deliveries"]["missing_in_postgres"] == ["DEL1", "DEL2"]  # findings are the pre-repair state


def test_repair_never_regresses_a_paid_invoice_in_postgres(stub_stores):
    stub_stores["excel"] = ({}, {"INV1": _excel_invoice("INV1", status="ISSUED")})  # e.g. workbook restored from backup
    stub_stores["pg"] = ({}, {"INV1": _pg_invoice("INV1", status="PAID")})

    report = reconciliation_tools.reconcile_post_sales(repair=True)

    assert stub_stores["upserts"] == []
    assert report["repaired"] == []
    assert "not regressing" in report["repair_failures"][0]["error"]
