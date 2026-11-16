# Phase 2: with POSTGRES_ID_AUTHORITY / POSTGRES_INVOICE_ID_AUTHORITY on,
# PostgreSQL is the authoritative FIRST writer for Delivery and Invoice; Excel
# is a projection. order-service's real behaviour (atomic sequence, per-key
# allocation, crash-safe withIdempotency replay, CAS) is proven against real
# Postgres in order-service/src/app.test.ts. Here the Postgres side is a faithful
# in-memory fake (allocation remembered per key, writes replayed per key) and
# what is proven is the orchestrator's contract: ordering, fail-closed, failure
# after each step, retry, crash and concurrency.
import threading
import uuid

import httpx
import openpyxl
import pytest

from app.tools import billing_tools, delivery_tools, reconciliation_tools


class SimulatedCrash(BaseException):
    """Not an Exception: models the process dying (nothing catches it)."""


class FakePostgres:
    def __init__(self):
        self.events: list[str] = []
        self.numbers: dict[tuple[str, str], int] = {}
        self.last: dict[str, int] = {}
        self.replays: dict[str, dict] = {}
        self.deliveries: dict[str, dict] = {}
        self.invoices: dict[str, dict] = {}
        self.down = False
        self.write_down = False
        self.force_number: int | None = None  # simulate an allocator that ignores the floor
        self.lock = threading.Lock()

    def allocate(self, kind, floor=0, idempotency_key=None):
        with self.lock:
            if self.down:
                raise RuntimeError("order-service down")
            if idempotency_key and (kind, idempotency_key) in self.numbers:
                return self.numbers[(kind, idempotency_key)]
            if self.force_number is not None:
                return self.force_number
            self.last[kind] = max(self.last.get(kind, 0), floor) + 1
            if idempotency_key:
                self.numbers[(kind, idempotency_key)] = self.last[kind]
            self.events.append(f"alloc:{kind}")
            return self.last[kind]

    def _write(self, table, ident, row, idempotency_key):
        with self.lock:
            if self.down or self.write_down:
                raise RuntimeError("order-service down")
            if idempotency_key and idempotency_key in self.replays:
                return self.replays[idempotency_key]
            table[ident] = row
            self.events.append(f"pg-write:{ident}")
            if idempotency_key:
                self.replays[idempotency_key] = row
            return row

    def write_delivery(self, **kw):
        row = {
            "externalDeliveryId": kw["external_delivery_id"], "status": kw["status"],
            "requestedDeliveryDate": f"{kw['requested_delivery_date']}T00:00:00.000Z" if kw["requested_delivery_date"] else None,
            "confirmedDeliveryDate": f"{kw['confirmed_delivery_date']}T00:00:00.000Z" if kw["confirmed_delivery_date"] else None,
            "quantity": kw["quantity"],
        }
        return self._write(self.deliveries, kw["external_delivery_id"], row, kw.get("idempotency_key"))

    def write_invoice(self, **kw):
        row = {
            "externalInvoiceId": kw["external_invoice_id"], "status": kw["status"], "invoiceAmount": kw["invoice_amount"],
            "dueDate": f"{kw['due_date']}T00:00:00.000Z" if kw["due_date"] else None, "quantityBilled": kw["quantity_billed"],
        }
        return self._write(self.invoices, kw["external_invoice_id"], row, kw.get("idempotency_key"))


@pytest.fixture
def pg(monkeypatch):
    fake = FakePostgres()
    monkeypatch.setattr(delivery_tools, "allocate_document_number", fake.allocate)
    monkeypatch.setattr(billing_tools, "allocate_document_number", fake.allocate)
    monkeypatch.setattr(delivery_tools, "dual_write_delivery", fake.write_delivery)
    monkeypatch.setattr(billing_tools, "dual_write_invoice", fake.write_invoice)
    return fake


@pytest.fixture
def delivery_flag(monkeypatch):
    monkeypatch.setenv("POSTGRES_ID_AUTHORITY", "1")


@pytest.fixture
def invoice_flag(monkeypatch):
    monkeypatch.setenv("POSTGRES_INVOICE_ID_AUTHORITY", "1")


def _delivery(tag="x", key=None, qty=1):
    return delivery_tools.create_delivery(
        sales_order_id=f"SO-PGF-{tag}", customer_id="C001", customer_name="ABC Corp", product_id="P011",
        product_name="Wireless Mouse", quantity=qty, idempotency_key=key or f"pgf-d-{tag}-{uuid.uuid4()}",
    )


def _invoice(tag="x", key=None, qty=2, price=10.0):
    return billing_tools.create_invoice(
        sales_order_id=f"SO-PGF-{tag}", delivery_id=f"DEL-PGF-{tag}", customer_id="C001", customer_name="ABC Corp",
        quantity_billed=qty, unit_price=price, payment_terms_days=30, notes="pgf",
        idempotency_key=key or f"pgf-i-{tag}-{uuid.uuid4()}",
    )


def _excel():
    return reconciliation_tools.read_excel_post_sales()


def _save_fails_once(monkeypatch, module):
    original = module.save_workbook
    state = {"n": 0}

    def flaky(wb, *a, **k):
        state["n"] += 1
        if state["n"] == 1:
            raise OSError("disk full")
        return original(wb, *a, **k)

    monkeypatch.setattr(module, "save_workbook", flaky)


# ------------------------------------------------------------------ flags off

def test_both_flags_off_keeps_excel_first_ids_and_never_touches_postgres(monkeypatch, pg):
    monkeypatch.delenv("POSTGRES_ID_AUTHORITY", raising=False)
    monkeypatch.delenv("POSTGRES_INVOICE_ID_AUTHORITY", raising=False)
    d, i = _delivery("off"), _invoice("off")
    assert d["created"] and d["delivery_id"].startswith("DEL") and i["created"] and i["invoice_id"].startswith("INV")
    assert pg.last == {} and not any(e.startswith("alloc") for e in pg.events)  # Excel-first path allocates nothing


def test_the_delivery_flag_does_not_enable_invoices(monkeypatch, pg, delivery_flag):
    monkeypatch.delenv("POSTGRES_INVOICE_ID_AUTHORITY", raising=False)
    _invoice("sep")
    assert "INVOICE" not in pg.last


# ----------------------------------------------------------- Postgres is first

def test_delivery_postgres_row_is_written_before_excel_and_excel_matches(pg, delivery_flag, monkeypatch):
    order = []
    original = delivery_tools.save_workbook
    monkeypatch.setattr(delivery_tools, "save_workbook", lambda wb, *a, **k: (order.append("excel-save"), original(wb, *a, **k))[1])
    out = _delivery("first")
    assert out["created"] is True and out["postgres_synced"] is True and out["excel_projected"] is True
    assert set(out) >= {"created", "delivery_id", "status", "requested_delivery_date", "confirmed_delivery_date"}
    assert pg.events.index(f"pg-write:{out['delivery_id']}") < len(pg.events)
    assert order == ["excel-save"] and f"pg-write:{out['delivery_id']}" in pg.events  # PG write happened; only then the single Excel save
    deliveries, _ = _excel()
    assert out["delivery_id"] in deliveries and out["delivery_id"] in pg.deliveries


def test_invoice_postgres_row_is_written_first_and_return_contract_is_kept(pg, invoice_flag):
    out = _invoice("first")
    assert set(out) >= {"created", "invoice_id", "invoice_amount", "due_date", "status", "postgres_synced"}
    assert out["invoice_amount"] == 20.0 and out["status"] == "ISSUED" and out["excel_projected"] is True
    _, invoices = _excel()
    assert out["invoice_id"] in invoices and out["invoice_id"] in pg.invoices


# ------------------------------------------------------------------ fail closed

@pytest.mark.parametrize("make,flag,sheet", [(_delivery, "delivery_flag", 0), (_invoice, "invoice_flag", 1)])
def test_postgres_unavailable_creates_nothing_anywhere_and_retry_works_after_recovery(request, pg, make, flag, sheet):
    request.getfixturevalue(flag)
    before = set(_excel()[sheet])
    key = f"down-{uuid.uuid4()}"
    pg.down = True
    out = make("down", key)
    assert out["created"] is False and "id authority unavailable" in out["reason"]
    assert set(_excel()[sheet]) == before and not pg.deliveries and not pg.invoices
    pg.down = False
    retry = make("down", key)
    assert retry["created"] is True
    assert len(set(_excel()[sheet]) - before) == 1


@pytest.mark.parametrize("make,flag,sheet,table", [(_delivery, "delivery_flag", 0, "deliveries"), (_invoice, "invoice_flag", 1, "invoices")])
def test_postgres_write_failing_after_allocation_leaves_excel_untouched_and_retry_reuses_the_number(request, pg, make, flag, sheet, table):
    request.getfixturevalue(flag)
    before = set(_excel()[sheet])
    key = f"wfail-{uuid.uuid4()}"
    pg.write_down = True
    assert make("wfail", key)["created"] is False
    assert set(_excel()[sheet]) == before
    burned = dict(pg.numbers)
    pg.write_down = False
    ok = make("wfail", key)
    assert ok["created"] is True
    assert dict(pg.numbers) == burned  # the retry got the number it had already been issued
    assert len(getattr(pg, table)) == 1


# -------------------------------------------- Excel fails AFTER Postgres succeeded

@pytest.mark.parametrize("make,flag,module,sheet,table,idkey", [
    (_delivery, "delivery_flag", delivery_tools, 0, "deliveries", "delivery_id"),
    (_invoice, "invoice_flag", billing_tools, 1, "invoices", "invoice_id"),
])
def test_failed_excel_write_does_not_lose_the_record_and_retry_completes_the_projection(request, monkeypatch, pg, make, flag, module, sheet, table, idkey):
    request.getfixturevalue(flag)
    before = set(_excel()[sheet])
    key = f"xfail-{uuid.uuid4()}"
    _save_fails_once(monkeypatch, module)

    first = make("xfail", key)
    assert first["created"] is True and first["postgres_synced"] is True and first["excel_projected"] is False
    assert len(getattr(pg, table)) == 1  # the authoritative record exists
    assert set(_excel()[sheet]) == before  # Excel has not caught up yet

    retry = make("xfail", key)  # same key: same id, same stored Postgres row, projection completes
    assert retry["created"] is True and retry["excel_projected"] is True
    assert retry[idkey] == first[idkey]
    assert len(getattr(pg, table)) == 1
    assert len(set(_excel()[sheet]) - before) == 1

    third = make("xfail", key)  # now a pure replay
    assert third[idkey] == first[idkey] and len(set(_excel()[sheet]) - before) == 1


def test_process_dying_between_the_postgres_write_and_the_excel_projection_is_recovered(pg, delivery_flag, monkeypatch):
    key = f"die-{uuid.uuid4()}"
    before = set(_excel()[0])
    original = delivery_tools._project_delivery_to_excel

    def dies(*a, **k):
        raise SimulatedCrash()

    monkeypatch.setattr(delivery_tools, "_project_delivery_to_excel", dies)
    with pytest.raises(SimulatedCrash):
        _delivery("die", key)
    assert len(pg.deliveries) == 1 and set(_excel()[0]) == before  # PG has it, Excel does not

    monkeypatch.setattr(delivery_tools, "_project_delivery_to_excel", original)
    recovered = _delivery("die", key)
    assert recovered["created"] is True and recovered["excel_projected"] is True
    assert list(pg.deliveries) == [recovered["delivery_id"]]  # still exactly one Postgres record
    assert len(set(_excel()[0]) - before) == 1


def test_excel_row_with_different_content_under_the_same_id_is_never_overwritten(pg, delivery_flag):
    first = _delivery("coll-a")
    pg.force_number = int(first["delivery_id"][3:])  # a misbehaving allocator re-issues a used number
    other = _delivery("coll-b")  # different sales order
    assert other["created"] is True and other["excel_projected"] is False
    deliveries, _ = _excel()
    assert deliveries[first["delivery_id"]]["sales_order_id"] == "SO-PGF-coll-a"  # untouched


# ---------------------------------------------------------- replay / validation

def test_replay_of_a_projected_key_returns_the_same_record_without_touching_postgres(pg, delivery_flag, invoice_flag):
    dk, ik = f"rp-d-{uuid.uuid4()}", f"rp-i-{uuid.uuid4()}"
    d1, i1 = _delivery("rp", dk), _invoice("rp", ik)
    events = list(pg.events)
    d2, i2 = _delivery("rp", dk), _invoice("rp", ik)
    assert d2["delivery_id"] == d1["delivery_id"] and i2["invoice_id"] == i1["invoice_id"]
    assert pg.events == events


@pytest.mark.parametrize("kwargs", [{"qty": 0}, {"qty": -1}, {"qty": None}])
def test_invalid_requests_allocate_nothing_and_write_nothing(pg, delivery_flag, invoice_flag, kwargs):
    assert _delivery("bad", qty=kwargs["qty"])["created"] is False
    assert _invoice("bad", qty=kwargs["qty"])["created"] is False
    assert _invoice("bad2", price=None)["created"] is False
    assert pg.last == {} and pg.events == []


# --------------------------------------------------------------- concurrency

def test_concurrent_creates_get_distinct_ids_and_all_are_projected(pg, delivery_flag, invoice_flag):
    ids, errors = [], []

    def work(n):
        try:
            ids.append((_delivery(f"c{n}")["delivery_id"], _invoice(f"c{n}")["invoice_id"]))
        except Exception as exc:  # pragma: no cover
            errors.append(exc)

    threads = [threading.Thread(target=work, args=(n,)) for n in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors, errors
    assert len({d for d, _ in ids}) == 8 and len({i for _, i in ids}) == 8
    deliveries, invoices = _excel()
    assert all(d in deliveries and i in invoices for d, i in ids)


def test_idempotency_survives_a_process_restart(pg, delivery_flag, tmp_path):
    """The idempotency record lives in the workbook file, not process memory: a
    NEW process projected the delivery; this one replays it without Postgres."""
    import os
    import subprocess
    import sys
    import textwrap

    key = f"restart-{uuid.uuid4()}"
    script = textwrap.dedent(f"""
        import os
        os.environ["POSTGRES_ID_AUTHORITY"] = "1"
        from app.tools import delivery_tools
        delivery_tools.allocate_document_number = lambda kind, floor=0, idempotency_key=None: floor + 500
        delivery_tools.dual_write_delivery = lambda **kw: {{"status": kw["status"], "confirmedDeliveryDate": kw["confirmed_delivery_date"] + "T00:00:00.000Z"}}
        print(delivery_tools.create_delivery("SO-PGF-restart", "C001", "ABC", "P011", "Mouse", 1, idempotency_key={key!r})["delivery_id"])
    """)
    proc = subprocess.run([sys.executable, "-I", "-c", "import sys; sys.path.insert(0, '.'); exec(sys.stdin.read())"],
                          input=script, capture_output=True, text=True, cwd=os.getcwd(), timeout=60)
    assert proc.returncode == 0, proc.stderr
    child_id = proc.stdout.strip().splitlines()[-1]
    before = list(pg.events)
    replay = _delivery("restart", key)
    assert replay["delivery_id"] == child_id and pg.events == before


# ------------------------------------------------------------- mark_invoice_paid

def _http_error(status):
    request = httpx.Request("PATCH", "http://order-service/invoices/x/status")
    return httpx.HTTPStatusError("boom", request=request, response=httpx.Response(status, request=request, text="x"))


def _legacy_invoice(monkeypatch, tag):
    """An invoice that predates Postgres authority: created Excel-first with the flag off."""
    monkeypatch.delenv("POSTGRES_INVOICE_ID_AUTHORITY", raising=False)
    monkeypatch.setattr(billing_tools, "dual_write_invoice", lambda **kw: {})
    out = _invoice(tag)
    assert out["created"]
    return out["invoice_id"]


def test_mark_paid_decides_in_postgres_first_then_projects_to_excel(monkeypatch, invoice_flag):
    iid = _legacy_invoice(monkeypatch, "mp1")
    monkeypatch.setenv("POSTGRES_INVOICE_ID_AUTHORITY", "1")
    seen = []
    monkeypatch.setattr(billing_tools, "sync_invoice_status_paid", lambda i: seen.append(i) or {"status": "PAID"})
    out = billing_tools.mark_invoice_paid(iid)
    assert seen == [iid]
    assert out == {"updated": True, "invoice_id": iid, "status": "PAID", "postgres_synced": True, "excel_projected": True}
    assert _excel()[1][iid]["status"] == "PAID"


def test_mark_paid_with_postgres_down_changes_nothing(monkeypatch):
    iid = _legacy_invoice(monkeypatch, "mp2")
    monkeypatch.setenv("POSTGRES_INVOICE_ID_AUTHORITY", "1")

    def down(_):
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(billing_tools, "sync_invoice_status_paid", down)
    out = billing_tools.mark_invoice_paid(iid)
    assert out["updated"] is False and "id authority unavailable" in out["reason"]
    assert _excel()[1][iid]["status"] == "ISSUED"


def test_mark_paid_illegal_transition_in_postgres_is_refused_and_excel_untouched(monkeypatch):
    iid = _legacy_invoice(monkeypatch, "mp3")
    monkeypatch.setenv("POSTGRES_INVOICE_ID_AUTHORITY", "1")
    monkeypatch.setattr(billing_tools, "sync_invoice_status_paid", lambda i: (_ for _ in ()).throw(_http_error(409)))
    out = billing_tools.mark_invoice_paid(iid)
    assert out["updated"] is False and "reason" in out
    assert _excel()[1][iid]["status"] == "ISSUED"


def test_mark_paid_backfills_a_pre_authority_invoice_missing_from_postgres_then_pays_it(monkeypatch):
    iid = _legacy_invoice(monkeypatch, "mp4")
    monkeypatch.setenv("POSTGRES_INVOICE_ID_AUTHORITY", "1")
    calls = {"patch": 0, "backfill": []}

    def patch(_):
        calls["patch"] += 1
        if calls["patch"] == 1:
            raise _http_error(404)
        return {"status": "PAID"}

    monkeypatch.setattr(billing_tools, "sync_invoice_status_paid", patch)
    monkeypatch.setattr(billing_tools, "dual_write_invoice", lambda **kw: calls["backfill"].append(kw["external_invoice_id"]) or {})
    out = billing_tools.mark_invoice_paid(iid)
    assert out["updated"] is True and calls["backfill"] == [iid] and calls["patch"] == 2
    assert _excel()[1][iid]["status"] == "PAID"


def test_mark_paid_unknown_invoice_is_not_found_and_repeat_is_idempotent(monkeypatch):
    monkeypatch.setenv("POSTGRES_INVOICE_ID_AUTHORITY", "1")
    monkeypatch.setattr(billing_tools, "sync_invoice_status_paid", lambda i: (_ for _ in ()).throw(_http_error(404)))
    out = billing_tools.mark_invoice_paid("INV-NOPE")
    assert out["updated"] is False and "No invoice found" in out["reason"]


def test_mark_paid_excel_failure_after_postgres_is_reported_and_repeat_completes_it(monkeypatch):
    iid = _legacy_invoice(monkeypatch, "mp5")
    monkeypatch.setenv("POSTGRES_INVOICE_ID_AUTHORITY", "1")
    monkeypatch.setattr(billing_tools, "sync_invoice_status_paid", lambda i: {"status": "PAID"})
    _save_fails_once(monkeypatch, billing_tools)
    first = billing_tools.mark_invoice_paid(iid)  # Postgres decided PAID; Excel write blew up
    assert first["updated"] is True and first["postgres_synced"] is True and first["excel_projected"] is False
    assert _excel()[1][iid]["status"] == "ISSUED"
    again = billing_tools.mark_invoice_paid(iid)
    assert again["updated"] is True and again["excel_projected"] is True
    assert _excel()[1][iid]["status"] == "PAID"
