# app/tests/test_customer_tools.py
import uuid

from app.tools.customer_tools import NEW_CUSTOMER_STARTER_CREDIT_LIMIT, create_customer, get_customer


def test_get_customer_exact_match():
    result = get_customer("ABC Corp")

    assert result is not None
    assert result["customer_id"] == "C001"


def test_get_customer_substring_match():
    result = get_customer("ABC")

    assert result is not None
    assert result["customer_id"] == "C001"


def test_get_customer_unknown_name_returns_none():
    assert get_customer("Definitely Not A Real Customer Inc") is None


def test_get_customer_none_returns_none_not_a_crash():
    # The bug found live via the adversarial test set: a request with no
    # customer name at all (an unresolved implicit reference, e.g. "the
    # customer who ordered last week") used to crash context_agent with
    # AttributeError instead of resolving to "not found" — the same
    # honest None-in-None-out contract get_product() already had.
    assert get_customer(None) is None


def test_create_customer_provisions_a_real_findable_row():
    # A unique name each run — this appends a real row to the shared
    # workbook and never removes it, so a fixed name would collide with
    # itself (and every other test run) on the substring-match lookup.
    name = f"Test Auto Customer {uuid.uuid4().hex[:8]}"

    created = create_customer(name)

    assert created["customer_name"] == name
    assert created["active"] is True
    assert created["credit_limit"] == NEW_CUSTOMER_STARTER_CREDIT_LIMIT
    assert created["customer_id"].startswith("C")

    # Provisioning must actually persist — a later, independent lookup
    # (not just the return value) has to find it.
    found = get_customer(name)
    assert found == created


def test_create_customer_ids_are_unique_and_increment():
    first = create_customer(f"Test Auto Customer {uuid.uuid4().hex[:8]}")
    second = create_customer(f"Test Auto Customer {uuid.uuid4().hex[:8]}")

    assert first["customer_id"] != second["customer_id"]
    assert int(second["customer_id"][1:]) > int(first["customer_id"][1:])
