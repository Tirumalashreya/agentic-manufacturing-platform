# app/tests/test_audit.py
from app.tools.audit_tools import get_audit_trail, record_audit_event
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
    record_audit_event("Project", "PRJ_TEST_001", "PROJECT_CREATED", {"contract_value": 1000000})

    trail = get_audit_trail("Project", "PRJ_TEST_001")

    assert len(trail) == 1
    assert trail[0]["event_type"] == "PROJECT_CREATED"
    assert trail[0]["details"] == {"contract_value": 1000000}
    assert trail[0]["event_id"].startswith("EVT")


def test_audit_trail_preserves_order_across_multiple_events():
    record_audit_event("Project", "PRJ_TEST_002", "PROJECT_CREATED")
    record_audit_event("Project", "PRJ_TEST_002", "MILESTONE_SIGNED_OFF")
    record_audit_event("Project", "PRJ_TEST_002", "PROJECT_CLOSED")

    trail = get_audit_trail("Project", "PRJ_TEST_002")

    assert [e["event_type"] for e in trail] == ["PROJECT_CREATED", "MILESTONE_SIGNED_OFF", "PROJECT_CLOSED"]


def test_audit_trail_is_scoped_to_entity_type_and_id():
    record_audit_event("Project", "PRJ_TEST_003", "PROJECT_CREATED")
    record_audit_event("ExportOrder", "PRJ_TEST_003", "CONFIRMED")  # same id, different entity_type

    assert len(get_audit_trail("Project", "PRJ_TEST_003")) == 1
    assert len(get_audit_trail("ExportOrder", "PRJ_TEST_003")) == 1


def test_record_audit_event_is_a_noop_without_entity_id():
    # Should not raise, and should not create a retrievable event.
    record_audit_event("Project", None, "PROJECT_CREATED")

    assert get_audit_trail("Project", None) == []


def test_record_audit_event_defaults_details_to_empty_dict():
    record_audit_event("ServiceOrder", "SVC_TEST_001", "SERVICE_ORDER_COMPLETED")

    trail = get_audit_trail("ServiceOrder", "SVC_TEST_001")

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
