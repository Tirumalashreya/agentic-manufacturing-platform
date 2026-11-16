# Phase 2 (Database Authority): creation paths that live in the legacy Excel
# store (Customer Master, SalesOrders, PurchaseOrders, FinancialAdjustments).
# Postgres-side protection for the same entities (unique constraints,
# transactions, find-or-create) is proven against real Postgres in
# order-service/src/app.test.ts. Here: race-freedom, retry safety and
# single-save atomicity of the Excel writers.
import threading
import uuid

import openpyxl
import pytest

from app.tools import customer_tools, financial_tools, procurement_tools, sales_tools


def _run_all(fns):
    errors = []

    def wrap(fn):
        try:
            fn()
        except Exception as exc:  # pragma: no cover - surfaced by the assert
            errors.append(exc)

    threads = [threading.Thread(target=wrap, args=(f,)) for f in fns]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors, errors


def _customers():
    return customer_tools.list_customers()


# ----------------------------------------------------------------- customers

def test_concurrent_create_customer_for_one_new_name_creates_one_row():
    name = f"Race Co {uuid.uuid4().hex[:8]}"
    out: list[dict] = []
    _run_all([lambda: out.append(customer_tools.create_customer(name)) for _ in range(8)])
    assert len({c["customer_id"] for c in out}) == 1
    assert sum(1 for c in _customers() if c["customer_name"] == name) == 1


def test_create_customer_matches_name_case_insensitively_and_keeps_return_shape():
    name = f"Shape Co {uuid.uuid4().hex[:8]}"
    first = customer_tools.create_customer(name)
    again = customer_tools.create_customer(name.upper())
    assert set(first) == {"customer_id", "customer_name", "active", "credit_limit"}
    assert again["customer_id"] == first["customer_id"]
    assert again["customer_name"] == name  # the existing record, untouched


def test_concurrent_create_customer_for_distinct_names_gets_distinct_ids_and_loses_none():
    names = [f"Distinct {i} {uuid.uuid4().hex[:6]}" for i in range(8)]
    out: list[dict] = []
    _run_all([lambda n=n: out.append(customer_tools.create_customer(n)) for n in names])
    assert len({c["customer_id"] for c in out}) == 8
    present = {c["customer_name"] for c in _customers()}
    assert set(names) <= present


# -------------------------------------------- mixed writers: no lost updates

def _so(tag, key=None):
    return sales_tools.create_sales_order(
        customer_id="C001", customer_name="ABC Corp", customer_active=True, product_id="P011",
        product_name="Wireless Mouse", quantity=1, unit_price=10.0, requested_deadline=None,
        idempotency_key=key or f"p2so-{tag}-{uuid.uuid4()}",
    )


def test_status_updates_creates_and_customers_running_together_lose_nothing():
    seed = _so("seed")["sales_order_id"]
    created: list[dict] = []
    po: list[dict] = []
    customers: list[dict] = []
    names = [f"Mixed {i} {uuid.uuid4().hex[:6]}" for i in range(3)]
    fns = (
        [lambda i=i: created.append(_so(f"m{i}")) for i in range(4)]
        + [lambda: sales_tools.update_sales_order_status(seed, "CREDIT_BLOCKED")]
        + [lambda i=i: po.append(procurement_tools.create_purchase_order(
            "PO-P2", "K1", "Comp", "V1", "Vendor", 5, 2.0, 7, idempotency_key=f"p2po-{i}-{uuid.uuid4()}")) for i in range(3)]
        + [lambda n=n: customers.append(customer_tools.create_customer(n)) for n in names]
    )
    _run_all(fns)
    orders = {o["sales_order_id"]: o for o in sales_tools.list_sales_orders()}
    assert orders[seed]["status"] == "CREDIT_BLOCKED"  # the status write survived the concurrent creates
    assert all(c["sales_order_id"] in orders for c in created) and len({c["sales_order_id"] for c in created}) == 4
    assert len({p["purchase_order_id"] for p in po}) == 3
    assert set(names) <= {c["customer_name"] for c in _customers()}


# --------------------------------------------------- idempotent creation paths

def test_concurrent_purchase_orders_with_one_key_create_exactly_one():
    key = f"p2po-same-{uuid.uuid4()}"
    out: list[dict] = []
    _run_all([lambda: out.append(procurement_tools.create_purchase_order(
        "PO-P2S", "K1", "Comp", "V1", "Vendor", 5, 2.0, 7, idempotency_key=key)) for _ in range(8)])
    assert len({o["purchase_order_id"] for o in out}) == 1
    wb = openpyxl.load_workbook("mock_erp.xlsx", read_only=True)
    rows = [r for r in wb["PurchaseOrders"].iter_rows(min_row=2, values_only=True) if r[1] == "PO-P2S"]
    wb.close()
    assert len(rows) == 1


def test_invalid_purchase_order_is_rejected_and_not_cached_as_success():
    key = f"p2po-bad-{uuid.uuid4()}"
    bad = procurement_tools.create_purchase_order("PO-P2B", "K1", "Comp", "V1", "Vendor", 0, 2.0, 7, idempotency_key=key)
    assert bad["created"] is False


def test_concurrent_financial_adjustments_with_one_key_create_exactly_one():
    key = f"p2fa-same-{uuid.uuid4()}"
    out: list[dict] = []
    _run_all([lambda: out.append(financial_tools.create_financial_adjustment(
        "CREDIT_MEMO", "C001", "ABC Corp", "INV-1", 100.0, "p2 test", idempotency_key=key)) for _ in range(8)])
    assert len({o["financial_adjustment_id"] for o in out}) == 1


def test_concurrent_approvals_of_one_pending_adjustment_resolve_exactly_once():
    created = financial_tools.create_financial_adjustment(
        "CREDIT_MEMO", "C001", "ABC Corp", "INV-2", float(financial_tools.FINANCIAL_APPROVAL_THRESHOLD), "p2 big", idempotency_key=f"p2fa-{uuid.uuid4()}")
    assert created["status"] == "PENDING_APPROVAL"
    fid = created["financial_adjustment_id"]
    out: list[dict] = []
    _run_all([lambda i=i: out.append(financial_tools.resolve_financial_approval(fid, "APPROVED", f"u{i}")) for i in range(8)])
    assert sum(1 for o in out if o["resolved"]) == 1
    assert financial_tools.find_financial_adjustment(fid)["status"] == "APPROVED"


def test_concurrent_posts_of_one_approved_adjustment_post_exactly_once():
    fid = financial_tools.create_financial_adjustment(
        "CREDIT_MEMO", "C001", "ABC Corp", "INV-3", 10.0, "p2 small", idempotency_key=f"p2fa-{uuid.uuid4()}")["financial_adjustment_id"]
    out: list[dict] = []
    _run_all([lambda: out.append(financial_tools.post_financial_adjustment(fid)) for _ in range(8)])
    assert sum(1 for o in out if o["posted"]) == 1
    assert financial_tools.find_financial_adjustment(fid)["status"] == "POSTED"


def test_invalid_financial_adjustment_amount_is_rejected():
    for amount in (None, 0, -5):
        out = financial_tools.create_financial_adjustment("CREDIT_MEMO", "C001", "ABC", "R", amount, "bad")
        assert out["created"] is False


# ------------------------------------- the business row and its key: ONE save

@pytest.mark.parametrize("make", [
    lambda k: sales_tools.create_sales_order("C001", "ABC", True, "P011", "Mouse", 1, 10.0, None, idempotency_key=k),
    lambda k: procurement_tools.create_purchase_order("PO-ONE", "K1", "Comp", "V1", "Vendor", 5, 2.0, 7, idempotency_key=k),
    lambda k: financial_tools.create_financial_adjustment("CREDIT_MEMO", "C001", "ABC", "R", 10.0, "one save", idempotency_key=k),
])
def test_row_and_idempotency_key_are_persisted_by_a_single_workbook_save(monkeypatch, make):
    """A crash between the business save and a separate key save would let a
    same-key retry create a second record. The key must ride in the same save."""
    original = openpyxl.workbook.workbook.Workbook.save
    key = f"one-save-{uuid.uuid4()}"
    saves: list[bool] = []  # per save: did that very save already contain the key row?

    def spy(self, filename):
        has_key = "IdempotencyKeys" in self.sheetnames and any(
            r[0] == key for r in self["IdempotencyKeys"].iter_rows(min_row=2, values_only=True)
        )
        saves.append(has_key)
        return original(self, filename)

    monkeypatch.setattr(openpyxl.workbook.workbook.Workbook, "save", spy)
    out = make(key)
    assert out["created"] is True
    # The FIRST save (the one that writes the business row) already carries the
    # key. There is no earlier save with the row but without the key.
    assert saves[0] is True
    # replay returns the same result and writes nothing new
    saves.clear()
    assert make(key) == out
    assert saves == []


def test_find_or_create_customer_is_one_atomic_server_call(monkeypatch):
    """The old GET-then-POST let two concurrent orders each create the same new
    customer. It must now be a single POST to the atomic endpoint."""
    import asyncio

    from app.integrations import manufacturing_services, order_domain

    calls = []

    class Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"id": "cust-1", "name": "X"}

    async def fake_request(method, url, **kw):
        calls.append((method, url.rsplit("/customers", 1)[1], kw.get("json")))
        return Resp()

    monkeypatch.setattr(manufacturing_services, "_request", fake_request)
    assert asyncio.run(order_domain.find_or_create_customer("X")) == "cust-1"
    assert calls == [("POST", "/find-or-create", {"name": "X"})]


def test_postgres_purchase_order_call_carries_the_idempotency_key_header(monkeypatch):
    import asyncio

    from app.integrations import manufacturing_services as mfg

    seen = []

    class Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"id": "po-1"}

    async def fake_request(method, url, **kw):
        seen.append(kw.get("headers"))
        return Resp()

    monkeypatch.setattr(mfg, "_request", fake_request)
    asyncio.run(mfg.create_purchase_order("v1", "c1", 5, "2026-12-01", idempotency_key="po-PRD1-c1-v1"))
    asyncio.run(mfg.create_purchase_order("v1", "c1", 5, "2026-12-01"))
    assert seen == [{"Idempotency-Key": "po-PRD1-c1-v1"}, None]
