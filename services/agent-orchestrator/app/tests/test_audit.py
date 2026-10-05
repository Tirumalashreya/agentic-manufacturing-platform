# app/tests/test_audit.py
import uuid

from app.tools.audit_tools import get_audit_trail, list_recent_audit_events, record_audit_event


# A fixed literal like "PRJ_TEST_001" collides with itself across pytest
# sessions whenever the isolation fixture's restore gets skipped (a hard
# kill, an interrupted run) — exactly what happened earlier this session
# and made these three tests flaky against real leftover data, not a bug
# in audit_tools itself. A fresh id per run makes that collision
# impossible regardless of what state the shared mock_erp.xlsx is in.
def _unique_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"
from app.tools.project_tools import (
    advance_milestone_status,
    bill_milestone,
    close_project,
    create_project,
)
from app.tools.financial_tools import create_financial_adjustment, post_financial_adjustment


def test_get_audit_trail_empty_for_unknown_entity():
    assert get_audit_trail("Project", "PRJ_DOES_NOT_EXIST") == []


def test_record_and_retrieve_single_event():
    project_id = _unique_id("PRJ_TEST")
    record_audit_event("Project", project_id, "PROJECT_CREATED", {"contract_value": 1000000})

    trail = get_audit_trail("Project", project_id)

    assert len(trail) == 1
    assert trail[0]["event_type"] == "PROJECT_CREATED"
    assert trail[0]["details"] == {"contract_value": 1000000}
    assert trail[0]["event_id"].startswith("EVT")


def test_audit_trail_preserves_order_across_multiple_events():
    project_id = _unique_id("PRJ_TEST")
    record_audit_event("Project", project_id, "PROJECT_CREATED")
    record_audit_event("Project", project_id, "MILESTONE_SIGNED_OFF")
    record_audit_event("Project", project_id, "PROJECT_CLOSED")

    trail = get_audit_trail("Project", project_id)

    assert [e["event_type"] for e in trail] == ["PROJECT_CREATED", "MILESTONE_SIGNED_OFF", "PROJECT_CLOSED"]


def test_audit_trail_is_scoped_to_entity_type_and_id():
    entity_id = _unique_id("PRJ_TEST")
    record_audit_event("Project", entity_id, "PROJECT_CREATED")
    record_audit_event("ExportOrder", entity_id, "CONFIRMED")  # same id, different entity_type

    assert len(get_audit_trail("Project", entity_id)) == 1
    assert len(get_audit_trail("ExportOrder", entity_id)) == 1


def test_record_audit_event_is_a_noop_without_entity_id():
    # Should not raise, and should not create a retrievable event.
    record_audit_event("Project", None, "PROJECT_CREATED")

    assert get_audit_trail("Project", None) == []


def test_record_audit_event_defaults_details_to_empty_dict():
    service_id = _unique_id("SVC_TEST")
    record_audit_event("ServiceOrder", service_id, "SERVICE_ORDER_COMPLETED")

    trail = get_audit_trail("ServiceOrder", service_id)

    assert trail[0]["details"] == {}


def test_project_lifecycle_produces_a_real_timeline():
    created = create_project(
        customer_id="C001",
        customer_name="ABC Corp",
        product_id=None,
        product_name=None,
        quantity=None,
        project_type="Manufacturing",
        scope_description="Audit trail test project.",
        contract_value=300_000,
    )
    milestone = created["milestones"][0]["milestone_id"]

    advance_milestone_status(milestone, "IN_PROGRESS")
    advance_milestone_status(milestone, "DELIVERED")
    advance_milestone_status(milestone, "SIGNED_OFF", signed_off_by="customer")
    bill_milestone(milestone)

    project_trail = get_audit_trail("Project", created["project_id"])
    assert [e["event_type"] for e in project_trail] == ["PROJECT_CREATED"]

    milestone_trail = get_audit_trail("ProjectMilestone", milestone)
    assert [e["event_type"] for e in milestone_trail] == [
        "MILESTONE_IN_PROGRESS", "MILESTONE_DELIVERED", "MILESTONE_SIGNED_OFF", "MILESTONE_BILLED",
    ]
    assert milestone_trail[2]["details"]["signed_off_by"] == "customer"


def test_financial_adjustment_approval_produces_a_real_timeline():
    created = create_financial_adjustment(
        adjustment_type="CREDIT_MEMO",
        customer_id="C001",
        customer_name="ABC Corp",
        reference=None,
        amount=5000,
        reason="Audit trail test.",
    )
    post_financial_adjustment(created["financial_adjustment_id"])

    trail = get_audit_trail("FinancialAdjustment", created["financial_adjustment_id"])

    assert [e["event_type"] for e in trail] == ["FINANCIAL_ADJUSTMENT_CREATED", "FINANCIAL_ADJUSTMENT_POSTED"]


def test_list_recent_audit_events_returns_newest_first():
    project_id = _unique_id("PRJ_RECENT")
    record_audit_event("Project", project_id, "PROJECT_CREATED")
    record_audit_event("Project", project_id, "PROJECT_CLOSED")

    events = list_recent_audit_events(limit=2)

    assert [e["entity_id"] for e in events] == [project_id, project_id]
    assert [e["event_type"] for e in events] == ["PROJECT_CLOSED", "PROJECT_CREATED"]


def test_list_recent_audit_events_respects_limit():
    prefix = _unique_id("PRJ_LIMIT")
    for i in range(5):
        record_audit_event("Project", f"{prefix}_{i}", "PROJECT_CREATED")

    events = list_recent_audit_events(limit=3)

    assert len(events) == 3
