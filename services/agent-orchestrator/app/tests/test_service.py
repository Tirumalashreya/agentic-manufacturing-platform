# app/tests/test_service.py
import pytest

from app.agents.service_agent import service_agent
from app.tools.service_tools import (
    complete_service_order,
    create_service_order,
    find_service_rate,
    update_service_order_status,
)


def _in_progress_order(service_type: str, scope_description: str) -> dict:
    created = create_service_order(
        customer_id="C001",
        customer_name="ABC Corp",
        service_type=service_type,
        scope_description=scope_description,
    )
    update_service_order_status(created["service_order_id"], "SCHEDULED")
    update_service_order_status(created["service_order_id"], "IN_PROGRESS")
    return created


@pytest.mark.asyncio
async def test_service_agent_extracts_installation():
    result = await service_agent("We need installation of 20 machines at our Hyderabad plant.")

    assert "install" in result.service_type.lower()
    assert len(result.scope_description) > 0


@pytest.mark.asyncio
async def test_service_agent_extracts_consulting():
    result = await service_agent("We'd like to hire consultants to review our production line efficiency.")

    assert "consult" in result.service_type.lower()


def test_create_service_order_succeeds():
    result = create_service_order(
        customer_id="C001",
        customer_name="ABC Corp",
        service_type="Installation",
        scope_description="Install 20 machines at the Hyderabad plant.",
    )

    assert result["created"] is True
    assert result["service_order_id"].startswith("SVC")
    assert result["status"] == "REQUESTED"


def test_create_service_order_rejects_empty_scope():
    result = create_service_order(
        customer_id="C001",
        customer_name="ABC Corp",
        service_type="Installation",
        scope_description="",
    )

    assert result["created"] is False


def test_find_service_rate_fixed():
    rate = find_service_rate("Installation")

    assert rate is not None
    assert rate["rate_type"] == "FIXED"
    assert rate["rate"] == 25000


def test_find_service_rate_hourly_substring_match():
    rate = find_service_rate("consulting services")

    assert rate is not None
    assert rate["rate_type"] == "HOURLY"
    assert rate["rate"] == 2500


def test_find_service_rate_no_match():
    rate = find_service_rate("Space Travel")

    assert rate is None


def test_create_service_order_fixed_rate_sets_estimated_amount():
    result = create_service_order(
        customer_id="C001",
        customer_name="ABC Corp",
        service_type="Installation",
        scope_description="Install 20 machines.",
    )

    assert result["rate_type"] == "FIXED"
    assert result["estimated_amount"] == 25000


def test_create_service_order_hourly_rate_needs_estimated_hours():
    no_hours = create_service_order(
        customer_id="C001",
        customer_name="ABC Corp",
        service_type="Consulting",
        scope_description="Review production line efficiency.",
    )
    assert no_hours["rate_type"] == "HOURLY"
    assert no_hours["estimated_amount"] is None

    with_hours = create_service_order(
        customer_id="C001",
        customer_name="ABC Corp",
        service_type="Consulting",
        scope_description="Review production line efficiency.",
        estimated_hours=10,
    )
    assert with_hours["estimated_amount"] == 25000


def test_update_service_order_status_valid_transition():
    created = create_service_order(
        customer_id="C001",
        customer_name="ABC Corp",
        service_type="Installation",
        scope_description="Install 20 machines.",
    )

    result = update_service_order_status(created["service_order_id"], "SCHEDULED")

    assert result["updated"] is True
    assert result["status"] == "SCHEDULED"


def test_update_service_order_status_rejects_invalid_transition():
    created = create_service_order(
        customer_id="C001",
        customer_name="ABC Corp",
        service_type="Installation",
        scope_description="Install 20 machines.",
    )

    result = update_service_order_status(created["service_order_id"], "COMPLETED")

    assert result["updated"] is False


def test_complete_service_order_fixed_rate_creates_invoice():
    order = _in_progress_order("Installation", "Install 20 machines.")

    result = complete_service_order(order["service_order_id"], signed_off_by="customer")

    assert result["completed"] is True
    assert result["billable_amount"] == 25000
    assert result["invoice_id"] is not None
    assert result["invoice_id"].startswith("INV")


def test_complete_service_order_hourly_rate_requires_actual_hours():
    order = _in_progress_order("Consulting", "Review production line efficiency.")

    result = complete_service_order(order["service_order_id"])

    assert result["completed"] is False
    assert "actual_hours" in result["reason"]


def test_complete_service_order_hourly_rate_bills_actual_hours():
    order = _in_progress_order("Consulting", "Review production line efficiency.")

    result = complete_service_order(order["service_order_id"], actual_hours=12, signed_off_by="customer")

    assert result["completed"] is True
    assert result["billable_amount"] == 30000  # 12 hours * 2500/hr, not any estimate
    assert result["invoice_id"] is not None


def test_complete_service_order_no_rate_on_file_completes_without_invoice():
    order = _in_progress_order("Space Travel", "Send a satellite up.")

    result = complete_service_order(order["service_order_id"], signed_off_by="customer")

    assert result["completed"] is True
    assert result["billable_amount"] is None
    assert result["invoice_id"] is None


def test_complete_service_order_rejects_when_not_in_progress():
    created = create_service_order(
        customer_id="C001",
        customer_name="ABC Corp",
        service_type="Installation",
        scope_description="Install 20 machines.",
    )

    result = complete_service_order(created["service_order_id"])

    assert result["completed"] is False


def test_complete_service_order_cannot_double_complete():
    order = _in_progress_order("Installation", "Install 20 machines.")

    complete_service_order(order["service_order_id"], signed_off_by="customer")
    second = complete_service_order(order["service_order_id"], signed_off_by="customer")

    assert second["completed"] is False


def test_complete_service_order_unknown_id():
    result = complete_service_order("SVC9999")

    assert result["completed"] is False
