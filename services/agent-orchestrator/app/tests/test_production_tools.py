# app/tests/test_production_tools.py
import openpyxl

from app.tools.production_tools import (
    MOCK_ERP_PATH,
    create_production_order,
    reserve_stock,
)


def _inventory_qty(product_id: str, plant: str) -> int:
    wb = openpyxl.load_workbook(MOCK_ERP_PATH)
    sheet = wb["Inventory"]
    for row in sheet.iter_rows(min_row=2, values_only=True):
        if row[0] == product_id and row[1] == plant:
            return row[2]
    raise AssertionError(f"No inventory row for {product_id}/{plant}")


def test_create_production_order_succeeds():
    result = create_production_order(
        sales_order_id="SO0001",
        product_id="P002",
        product_name="Laptop - Gaming",
        quantity=10,
        lead_time_days=25,
    )

    assert result["created"] is True
    assert result["production_order_id"].startswith("PO")
    assert result["status"] == "PLANNED"


def test_create_production_order_rejects_bad_quantity():
    result = create_production_order(
        sales_order_id="SO0001",
        product_id="P002",
        product_name="Laptop - Gaming",
        quantity=0,
        lead_time_days=25,
    )

    assert result["created"] is False


def test_create_production_order_marks_configuration_required():
    result = create_production_order(
        sales_order_id="SO0001",
        product_id="P001",
        product_name="Laptop - Standard",
        quantity=5,
        lead_time_days=20,
        requires_configuration=True,
        configuration_notes="Configuration Agent not yet built.",
    )

    assert result["created"] is True


def test_reserve_stock_decrements_real_inventory():
    # Sums across whichever plant(s) actually hold stock, rather than
    # assuming PLANT01 specifically — same fragility already noted and
    # fixed below for P002 (live demo data shifts which plant has real
    # stock; PLANT01 for P011 is legitimately 0 as of this session).
    def total_p011_stock():
        return _inventory_qty("P011", "PLANT01") + _inventory_qty("P011", "PLANT02")

    before = total_p011_stock()

    result = reserve_stock(
        sales_order_id="SO0002",
        product_id="P011",
        product_name="Wireless Mouse",
        quantity=3,
    )

    assert result["reserved"] is True
    assert sum(a["quantity"] for a in result["allocations"]) == 3

    after = total_p011_stock()
    assert before - after == 3


def test_reserve_stock_rejects_insufficient_stock():
    # A quantity no real stock level could ever satisfy, rather than
    # depending on a specific product happening to be at zero in the
    # shared mock_erp.xlsx — that assumption broke once P002 was
    # legitimately restocked for demo purposes, which is exactly the kind
    # of external-state fragility this rewrite avoids.
    result = reserve_stock(
        sales_order_id="SO0003",
        product_id="P002",
        product_name="Laptop - Gaming",
        quantity=999_999_999,
    )

    assert result["reserved"] is False


def test_reserve_stock_rejects_bad_quantity():
    result = reserve_stock(
        sales_order_id="SO0004",
        product_id="P011",
        product_name="Wireless Mouse",
        quantity=0,
    )

    assert result["reserved"] is False


# Independent-audit fix: reserve_stock's read-decide-write sequence had no
# lock — two concurrent reservations for the same product could both read
# the same available quantity and both succeed, overselling real stock.
# Real threads against the real function, not a sequential call, since a
# sequential test can't exercise the race at all.
def test_reserve_stock_concurrent_same_key_produces_exactly_one_real_reservation():
    import threading

    key = "concurrency-test-reserve-key-001"
    results: list[dict] = []

    def call():
        results.append(reserve_stock(
            sales_order_id="SO-CONC-RSV-1", product_id="P011", product_name="Wireless Mouse",
            quantity=2, idempotency_key=key,
        ))

    threads = [threading.Thread(target=call) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    reservation_ids = {r["reservation_id"] for r in results if r["reserved"]}
    assert len(reservation_ids) == 1, f"expected exactly one real reservation, got {reservation_ids}"


def test_reserve_stock_concurrent_different_keys_each_reserve_without_overselling_or_losing_a_decrement():
    import threading

    # reserve_stock allocates across plants in sheet order, so the
    # lost-update check must sum every plant — asserting on PLANT02 alone
    # passed or failed depending on how much PLANT01 stock earlier tests
    # (or the demo data) left behind, not on whether a decrement was lost.
    def total_p011():
        return _inventory_qty("P011", "PLANT01") + _inventory_qty("P011", "PLANT02")

    before = total_p011()
    results: list[dict] = []

    def call(key: str):
        results.append(reserve_stock(
            sales_order_id="SO-CONC-RSV-2", product_id="P011", product_name="Wireless Mouse",
            quantity=1, idempotency_key=key,
        ))

    threads = [threading.Thread(target=call, args=(f"concurrency-distinct-reserve-{i}",)) for i in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    succeeded = [r for r in results if r["reserved"]]
    assert len(succeeded) == 5  # every distinct-key reservation genuinely went through

    after = total_p011()
    # The real proof the lock prevents a lost-update race, not just
    # duplicate creation: if two threads had read the same stale quantity
    # and both written their own decrement back, the total drop would be
    # LESS than 5 (a later overwrite clobbering an earlier one). Exactly 5
    # means every single decrement was applied against the true current
    # value, never a stale one.
    assert before - after == 5
