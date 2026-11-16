# Phase 2: PostgreSQL as first writer for Customer and SalesOrder, and the
# reconciler for both (plus the postgres_to_excel direction for all four
# entities). Real-Postgres behaviour of the endpoints is proven in
# order-service/src/app.test.ts; here Postgres is a faithful in-memory fake.
import threading
import uuid

import openpyxl
import pytest
from fastapi import HTTPException

from app.routers import reconciliation as router
from app.tools import customer_tools, reconciliation_tools, sales_tools


class FakePG:
    def __init__(self):
        self.down = False
        self.numbers: dict[tuple[str, str], int] = {}
        self.last: dict[str, int] = {}
        self.customers: dict[str, dict] = {}   # by pg id
        self.orders: dict[str, dict] = {}      # by pg id
        self.events: list[str] = []
        self.lock = threading.Lock()

    def allocate(self, kind, floor=0, idempotency_key=None):
        with self.lock:
            if self.down:
                raise RuntimeError("order-service down")
            if idempotency_key and (kind, idempotency_key) in self.numbers:
                return self.numbers[(kind, idempotency_key)]
            self.last[kind] = max(self.last.get(kind, 0), floor) + 1
            if idempotency_key:
                self.numbers[(kind, idempotency_key)] = self.last[kind]
            self.events.append(f"alloc:{kind}")
            return self.last[kind]

    def find_or_create_customer(self, name, external_customer_id=None, credit_limit=None, active=None):
        with self.lock:
            if self.down:
                raise RuntimeError("order-service down")
            for c in self.customers.values():
                if c["name"] == name:
                    if external_customer_id and not c["externalCustomerId"]:
                        c["externalCustomerId"] = external_customer_id
                    if credit_limit is not None and c["creditLimit"] is None:
                        c["creditLimit"] = credit_limit
                    return c
            c = {"id": f"pg-{uuid.uuid4().hex[:8]}", "name": name, "externalCustomerId": external_customer_id,
                 "creditLimit": credit_limit, "active": True if active is None else active}
            self.customers[c["id"]] = c
            self.events.append(f"pg-customer:{name}")
            return c

    def create_order(self, customer_pg_id, due_date, value, external_order_id, priority=0, idempotency_key=None):
        with self.lock:
            if self.down:
                raise RuntimeError("order-service down")
            for o in self.orders.values():
                if o["externalOrderId"] == external_order_id:
                    return o
            cust = self.customers[customer_pg_id]
            o = {"id": f"pgo-{uuid.uuid4().hex[:8]}", "externalOrderId": external_order_id, "value": value, "dueDate": f"{due_date}T00:00:00.000Z",
                 "customerId": customer_pg_id, "customer": {"externalCustomerId": cust["externalCustomerId"], "name": cust["name"]}, "orderLines": []}
            self.orders[o["id"]] = o
            self.events.append(f"pg-order:{external_order_id}")
            return o


@pytest.fixture
def pg(monkeypatch):
    fake = FakePG()
    for mod in (customer_tools, sales_tools):
        monkeypatch.setattr(mod, "allocate_document_number", fake.allocate)
        monkeypatch.setattr(mod, "find_or_create_customer_sync", fake.find_or_create_customer)
    monkeypatch.setattr(sales_tools, "create_sales_order_record_sync", fake.create_order)
    return fake


def _excel_rows(sheet):
    wb = openpyxl.load_workbook("mock_erp.xlsx", read_only=True)
    try:
        return list(wb[sheet].iter_rows(min_row=2, values_only=True)) if sheet in wb.sheetnames else []
    finally:
        wb.close()


def _so(tag, key=None, **kw):
    args = dict(customer_id="C001", customer_name="ABC Corp", customer_active=True, product_id="P011",
                product_name="Mouse", quantity=2, unit_price=10.0, requested_deadline="2026-12-01",
                idempotency_key=key or f"pgo-{tag}-{uuid.uuid4()}")
    args.update(kw)
    return sales_tools.create_sales_order(**args)


# ------------------------------------------------------------------- customers

def test_customer_flag_off_is_the_unchanged_excel_path(monkeypatch, pg):
    monkeypatch.delenv("POSTGRES_CUSTOMER_AUTHORITY", raising=False)
    out = customer_tools.create_customer(f"Legacy Co {uuid.uuid4().hex[:6]}")
    assert out["customer_id"].startswith("C") and pg.events == []


def test_customer_postgres_first_creates_in_postgres_then_projects_with_the_same_id(monkeypatch, pg):
    monkeypatch.setenv("POSTGRES_CUSTOMER_AUTHORITY", "1")
    name = f"PG First {uuid.uuid4().hex[:6]}"
    out = customer_tools.create_customer(name)
    assert set(out) == {"customer_id", "customer_name", "active", "credit_limit"}
    pgrow = next(c for c in pg.customers.values() if c["name"] == name)
    assert pgrow["externalCustomerId"] == out["customer_id"] and pgrow["creditLimit"] == out["credit_limit"]
    assert any(r[0] == out["customer_id"] and r[1] == name for r in _excel_rows("Customer Master"))
    again = customer_tools.create_customer(name.upper())  # exact (case-insensitive) match: no second customer anywhere
    assert again["customer_id"] == out["customer_id"] and len(pg.customers) == 1


def test_customer_postgres_down_fails_closed_and_writes_nothing(monkeypatch, pg):
    monkeypatch.setenv("POSTGRES_CUSTOMER_AUTHORITY", "1")
    before = len(_excel_rows("Customer Master"))
    pg.down = True
    with pytest.raises(RuntimeError, match="authority unavailable"):
        customer_tools.create_customer("Never Created Co")
    assert len(_excel_rows("Customer Master")) == before


def test_customer_excel_failure_after_postgres_keeps_the_record_and_retry_projects_it(monkeypatch, pg):
    monkeypatch.setenv("POSTGRES_CUSTOMER_AUTHORITY", "1")
    name = f"Flaky Excel {uuid.uuid4().hex[:6]}"
    original = customer_tools.save_workbook
    state = {"n": 0}

    def flaky(wb, *a, **k):
        state["n"] += 1
        if state["n"] == 1:
            raise OSError("disk full")
        return original(wb, *a, **k)

    monkeypatch.setattr(customer_tools, "save_workbook", flaky)
    first = customer_tools.create_customer(name)  # Postgres has it; Excel write failed (logged, not raised)
    assert any(c["name"] == name for c in pg.customers.values())
    assert not any(r[1] == name for r in _excel_rows("Customer Master"))
    retry = customer_tools.create_customer(name)
    assert retry["customer_id"] == first["customer_id"]
    assert sum(1 for r in _excel_rows("Customer Master") if r[1] == name) == 1
    assert len(pg.customers) == 1


def test_concurrent_postgres_first_customer_creates_one_customer_per_name(monkeypatch, pg):
    monkeypatch.setenv("POSTGRES_CUSTOMER_AUTHORITY", "1")
    name = f"Conc Co {uuid.uuid4().hex[:6]}"
    out, errors = [], []

    def work():
        try:
            out.append(customer_tools.create_customer(name))
        except Exception as exc:  # pragma: no cover
            errors.append(exc)

    threads = [threading.Thread(target=work) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors, errors
    assert len({c["customer_id"] for c in out}) == 1
    assert sum(1 for r in _excel_rows("Customer Master") if r[1] == name) == 1


# ---------------------------------------------------------------- sales orders

def test_sales_order_flag_off_is_unchanged(monkeypatch, pg):
    monkeypatch.delenv("POSTGRES_SALES_ORDER_AUTHORITY", raising=False)
    out = _so("off")
    assert out["created"] and out["sales_order_id"].startswith("SO") and pg.events == []


def test_sales_order_postgres_first_orders_the_writes_and_keeps_the_contract(monkeypatch, pg):
    monkeypatch.setenv("POSTGRES_SALES_ORDER_AUTHORITY", "1")
    out = _so("first")
    assert set(out) >= {"created", "sales_order_id", "total_amount", "status"}
    assert out["total_amount"] == 20.0 and out["status"] == "CONFIRMED" and out["excel_projected"] is True
    assert pg.events.index(f"alloc:SALES_ORDER") < pg.events.index(f"pg-order:{out['sales_order_id']}")
    assert any(r[0] == out["sales_order_id"] for r in _excel_rows("SalesOrders"))
    assert any(o["externalOrderId"] == out["sales_order_id"] for o in pg.orders.values())


@pytest.mark.parametrize("kw", [{"customer_id": None}, {"customer_active": False}, {"product_id": None}, {"unit_price": None}, {"quantity": 0}])
def test_invalid_sales_orders_allocate_nothing(monkeypatch, pg, kw):
    monkeypatch.setenv("POSTGRES_SALES_ORDER_AUTHORITY", "1")
    assert _so("bad", **kw)["created"] is False
    assert pg.events == []


def test_sales_order_postgres_down_creates_nothing(monkeypatch, pg):
    monkeypatch.setenv("POSTGRES_SALES_ORDER_AUTHORITY", "1")
    before = len(_excel_rows("SalesOrders"))
    pg.down = True
    out = _so("down")
    assert out["created"] is False and "id authority unavailable" in out["reason"]
    assert len(_excel_rows("SalesOrders")) == before and not pg.orders


def test_sales_order_excel_failure_after_postgres_is_recovered_by_a_same_key_retry(monkeypatch, pg):
    monkeypatch.setenv("POSTGRES_SALES_ORDER_AUTHORITY", "1")
    key = f"so-retry-{uuid.uuid4()}"
    before = len(_excel_rows("SalesOrders"))
    original = sales_tools.save_workbook
    state = {"n": 0}

    def flaky(wb, *a, **k):
        state["n"] += 1
        if state["n"] == 1:
            raise OSError("disk full")
        return original(wb, *a, **k)

    monkeypatch.setattr(sales_tools, "save_workbook", flaky)
    first = _so("retry", key)
    assert first["created"] and first["excel_projected"] is False and len(pg.orders) == 1
    assert len(_excel_rows("SalesOrders")) == before
    retry = _so("retry", key)
    assert retry["sales_order_id"] == first["sales_order_id"] and retry["excel_projected"] is True
    assert len(pg.orders) == 1 and len(_excel_rows("SalesOrders")) == before + 1


def test_concurrent_postgres_first_sales_orders_get_distinct_ids(monkeypatch, pg):
    monkeypatch.setenv("POSTGRES_SALES_ORDER_AUTHORITY", "1")
    ids, errors = [], []

    def work(n):
        try:
            ids.append(_so(f"c{n}")["sales_order_id"])
        except Exception as exc:  # pragma: no cover
            errors.append(exc)

    threads = [threading.Thread(target=work, args=(n,)) for n in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors, errors
    assert len(set(ids)) == 8 and {r[0] for r in _excel_rows("SalesOrders")} >= set(ids)


# ------------------------------------------------------------------ reconciler

@pytest.fixture
def stores(monkeypatch):
    state = {"ec": {}, "eo": {}, "pc": {}, "po": {}, "linked": [], "orders": []}
    monkeypatch.setattr(reconciliation_tools, "read_excel_orders", lambda: (state["ec"], state["eo"]))
    monkeypatch.setattr(reconciliation_tools, "list_postgres_customers", lambda: state["pc"])
    monkeypatch.setattr(reconciliation_tools, "list_postgres_sales_orders", lambda: state["po"])
    monkeypatch.setattr(reconciliation_tools, "find_or_create_customer_sync", lambda name, **kw: state["linked"].append((name, kw)) or {"id": "pg-x"})
    monkeypatch.setattr(reconciliation_tools, "create_sales_order_record_sync", lambda cid, due, value, oid, **kw: state["orders"].append((oid, value)) or {})
    return state


def _ec(cid, name="ABC", active=True, limit=50000.0):
    return {"customer_id": cid, "customer_name": name, "active": active, "credit_limit": limit}


def _pc(pid, name, ext=None, limit=None, active=True):
    return {"id": pid, "name": name, "externalCustomerId": ext, "creditLimit": limit, "active": active}


def _eo(oid, cust="C001", name="ABC", total=20.0):
    return {"sales_order_id": oid, "customer_id": cust, "customer_name": name, "product_id": "P011", "product_name": "Mouse",
            "quantity": 2, "unit_price": 10.0, "total_amount": total, "requested_deadline": "2026-12-01", "status": "CONFIRMED", "created_at": "x"}


def _po(pid, oid, value=20.0, name="ABC", ext="C001"):
    return {"id": pid, "externalOrderId": oid, "value": value, "dueDate": "2026-12-01T00:00:00.000Z", "status": "APPROVED",
            "customer": {"externalCustomerId": ext, "name": name}, "orderLines": []}


def test_orders_report_finds_every_kind_of_drift_and_mutates_nothing(stores):
    stores["ec"] = {"C001": _ec("C001"), "C002": _ec("C002", "Beta"), "C003": _ec("C003", "Gamma"), "C004": _ec("C004", "Delta", limit=1.0)}
    stores["pc"] = {
        "p1": _pc("p1", "ABC", "C001", 50000.0), "p3": _pc("p3", "Gamma"),            # C003 only by name -> unlinked
        "p4": _pc("p4", "Delta", "C004", 99.0), "p9": _pc("p9", "Pg Only", "C900", 1.0), "p10": _pc("p10", "SAP Co"),
    }
    stores["eo"] = {"SO0001": _eo("SO0001"), "SO0002": _eo("SO0002"), "SO0003": _eo("SO0003", total=5.0)}
    stores["po"] = {"o1": _po("o1", "SO0001"), "o3": _po("o3", "SO0003", value=7.0), "o9": _po("o9", "SO0900"), "o10": {**_po("o10", None), "externalOrderId": None}}
    r = reconciliation_tools.reconcile_orders()
    assert r["consistent"] is False
    assert r["customers"]["missing_in_postgres"] == ["C002"] and r["customers"]["unlinked_in_postgres"] == ["C003"]
    assert r["customers"]["missing_in_excel"] == ["C900"]
    assert [m["id"] for m in r["customers"]["mismatched"]] == ["C004"]
    assert r["customers"]["postgres_without_external_id"] == 2
    assert r["sales_orders"]["missing_in_postgres"] == ["SO0002"] and r["sales_orders"]["missing_in_excel"] == ["SO0900"]
    assert r["sales_orders"]["mismatched"][0]["fields"] == {"value": {"excel": 5.0, "postgres": 7.0}}
    assert r["sales_orders"]["postgres_without_external_id"] == 1
    assert stores["linked"] == [] and stores["orders"] == []


def test_orders_report_is_consistent_when_stores_agree_even_with_postgres_only_rows(stores):
    stores["ec"] = {"C001": _ec("C001")}
    stores["pc"] = {"p1": _pc("p1", "ABC", "C001", 50000.0), "p2": _pc("p2", "SAP Co")}
    stores["eo"] = {"SO0001": _eo("SO0001")}
    stores["po"] = {"o1": _po("o1", "SO0001")}
    assert reconciliation_tools.reconcile_orders()["consistent"] is True


def test_excel_to_postgres_repair_adopts_and_creates_but_never_overwrites_values(stores):
    stores["ec"] = {"C002": _ec("C002", "Beta"), "C003": _ec("C003", "Gamma"), "C004": _ec("C004", "Delta", limit=1.0)}
    stores["pc"] = {"p3": _pc("p3", "Gamma"), "p4": _pc("p4", "Delta", "C004", 99.0)}
    stores["eo"] = {"SO0002": _eo("SO0002")}
    r = reconciliation_tools.reconcile_orders(repair=True)
    assert sorted(r["repaired"]) == ["C002", "C003", "SO0002"]
    assert {n for n, _ in stores["linked"]} >= {"Beta", "Gamma"}
    assert stores["orders"] == [("SO0002", 20.0)]
    assert any(f["id"] == "C004" and "never overwrites" in f["error"] for f in r["repair_failures"])


def test_postgres_to_excel_repair_projects_only_the_allowlisted_ids(stores):
    tag = uuid.uuid4().hex[:5]
    stores["pc"] = {"p1": _pc("p1", f"Proj A {tag}", "C801", 10.0), "p2": _pc("p2", f"Proj B {tag}", "C802", 20.0)}
    stores["po"] = {"o1": _po("o1", "SO0801", 33.0, f"Proj A {tag}", "C801"), "o2": _po("o2", "SO0802", 44.0, f"Proj B {tag}", "C802")}
    r = reconciliation_tools.reconcile_orders(repair=True, direction="postgres_to_excel", only_ids={"C801", "SO0801"})
    assert sorted(r["repaired"]) == ["C801", "SO0801"] and r["repair_failures"] == []
    assert any(row[0] == "C801" for row in _excel_rows("Customer Master"))
    assert not any(row[0] == "C802" for row in _excel_rows("Customer Master"))
    assert any(row[0] == "SO0801" and row[7] == 33.0 for row in _excel_rows("SalesOrders"))
    assert not any(row[0] == "SO0802" for row in _excel_rows("SalesOrders"))
    again = reconciliation_tools.reconcile_orders(repair=True, direction="postgres_to_excel", only_ids={"C801", "SO0801"})
    assert sum(1 for row in _excel_rows("Customer Master") if row[0] == "C801") == 1  # idempotent


def test_postgres_to_excel_repair_for_deliveries_and_invoices_only_touches_requested_ids(monkeypatch):
    tag = uuid.uuid4().hex[:5]
    pd = {f"DEL9{tag}1": {"externalDeliveryId": f"DEL9{tag}1", "externalSalesOrderId": "SO-1", "customerId": "C001", "customerName": "ABC",
                          "productId": "P011", "productName": "Mouse", "quantity": 3, "status": "DISPATCHED",
                          "confirmedDeliveryDate": "2026-12-02T00:00:00.000Z"},
          f"DEL9{tag}2": {"externalDeliveryId": f"DEL9{tag}2", "quantity": 1, "status": "DISPATCHED"}}
    pi = {f"INV9{tag}1": {"externalInvoiceId": f"INV9{tag}1", "externalSalesOrderId": "SO-1", "externalDeliveryId": f"DEL9{tag}1", "customerId": "C001",
                          "customerName": "ABC", "quantityBilled": 3, "unitPrice": 5.0, "invoiceAmount": 15.0, "status": "ISSUED"}}
    monkeypatch.setattr(reconciliation_tools, "read_excel_post_sales", lambda: ({}, {}))
    monkeypatch.setattr(reconciliation_tools, "list_postgres_deliveries_and_invoices", lambda: (pd, pi))
    r = reconciliation_tools.reconcile_post_sales(repair=True, direction="postgres_to_excel", only_ids={f"DEL9{tag}1", f"INV9{tag}1"})
    assert sorted(r["repaired"]) == sorted([f"DEL9{tag}1", f"INV9{tag}1"])
    assert any(row[0] == f"DEL9{tag}1" and row[6] == 3 for row in _excel_rows("Deliveries"))
    assert not any(row[0] == f"DEL9{tag}2" for row in _excel_rows("Deliveries"))
    assert any(row[0] == f"INV9{tag}1" and row[7] == 15.0 for row in _excel_rows("Invoices"))


def test_router_refuses_a_blanket_postgres_to_excel_repair_and_unknown_directions():
    with pytest.raises(HTTPException) as no_ids:
        router._check("postgres_to_excel", None)
    assert no_ids.value.status_code == 400
    with pytest.raises(HTTPException):
        router._check("sideways", ["x"])
    assert router._check("excel_to_postgres", None) is None
    assert router._check("postgres_to_excel", ["DEL1"]) == {"DEL1"}
