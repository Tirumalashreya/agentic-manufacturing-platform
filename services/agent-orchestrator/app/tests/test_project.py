# app/tests/test_project.py
import pytest

from app.agents.project_agent import project_agent
from app.tools.project_tools import (
    advance_milestone_status,
    bill_milestone,
    close_project,
    create_project,
    find_project,
    find_project_milestones,
    list_open_milestones,
    list_projects,
)


@pytest.mark.asyncio
async def test_project_agent_extracts_stated_contract_value():
    result = await project_agent(
        "We'd like to award a turnkey installation project for our new plant, "
        "contract value 5,000,000, delivered in phases."
    )

    assert "install" in result.project_type.lower() or "turnkey" in result.project_type.lower()
    assert result.contract_value == 5_000_000


@pytest.mark.asyncio
async def test_project_agent_never_invents_contract_value():
    result = await project_agent(
        "We want to start a large manufacturing project for a new product line, no budget decided yet."
    )

    assert result.contract_value is None


def _new_project(contract_value=1_000_000, product_id=None, product_name=None, quantity=None):
    return create_project(
        customer_id="C001",
        customer_name="ABC Corp",
        product_id=product_id,
        product_name=product_name,
        quantity=quantity,
        project_type="Manufacturing",
        scope_description="Build a new production line for ABC Corp.",
        contract_value=contract_value,
    )


def test_create_project_splits_contract_value_across_milestones():
    result = _new_project(contract_value=1_000_000)

    assert result["created"] is True
    assert result["project_id"].startswith("PRJ")
    assert len(result["milestones"]) == 3

    amounts = {m["milestone_name"]: m["amount"] for m in result["milestones"]}
    assert amounts["ADVANCE"] == 300_000
    assert amounts["DELIVERY"] == 400_000
    assert amounts["FINAL"] == 300_000
    assert sum(amounts.values()) == 1_000_000


def test_create_project_without_contract_value_leaves_amounts_unset():
    result = _new_project(contract_value=None)

    assert result["created"] is True
    assert all(m["amount"] is None for m in result["milestones"])


def test_create_project_rejects_empty_scope():
    result = create_project(
        customer_id="C001",
        customer_name="ABC Corp",
        product_id=None,
        product_name=None,
        quantity=None,
        project_type="Manufacturing",
        scope_description="",
        contract_value=1_000_000,
    )

    assert result["created"] is False


def test_create_project_rejects_bad_quantity():
    result = _new_project(product_id="P001", product_name="Laptop - Standard", quantity=0)

    assert result["created"] is False


def test_find_project_and_milestones():
    created = _new_project()

    project = find_project(created["project_id"])
    milestones = find_project_milestones(created["project_id"])

    assert project is not None
    assert project["status"] == "AWARDED"
    assert len(milestones) == 3
    assert {m["milestone_id"] for m in milestones} == {m["milestone_id"] for m in created["milestones"]}


def _advance_to_signed_off(milestone_id: str) -> None:
    advance_milestone_status(milestone_id, "IN_PROGRESS")
    advance_milestone_status(milestone_id, "DELIVERED")
    advance_milestone_status(milestone_id, "SIGNED_OFF", signed_off_by="customer")


def test_milestone_status_progresses_in_order():
    created = _new_project()
    milestone_id = created["milestones"][0]["milestone_id"]

    _advance_to_signed_off(milestone_id)

    milestones = find_project_milestones(created["project_id"])
    advance = next(m for m in milestones if m["milestone_id"] == milestone_id)
    assert advance["status"] == "SIGNED_OFF"
    assert advance["signed_off_by"] == "customer"
    assert advance["signed_off_at"] is not None


def test_milestone_status_rejects_skipping_a_stage():
    created = _new_project()
    milestone_id = created["milestones"][0]["milestone_id"]

    result = advance_milestone_status(milestone_id, "DELIVERED")

    assert result["updated"] is False


def test_bill_milestone_requires_signed_off():
    created = _new_project()
    milestone_id = created["milestones"][0]["milestone_id"]

    result = bill_milestone(milestone_id)

    assert result["billed"] is False


def test_bill_milestone_nets_out_retention_and_creates_invoice():
    created = _new_project(contract_value=1_000_000)
    advance_milestone = created["milestones"][0]  # ADVANCE, 300_000
    _advance_to_signed_off(advance_milestone["milestone_id"])

    result = bill_milestone(advance_milestone["milestone_id"])

    assert result["billed"] is True
    assert result["invoice_id"] is not None
    assert result["retained_amount"] == 30_000  # 10% of 300,000
    assert result["billed_amount"] == 270_000

    project = find_project(created["project_id"])
    assert project["retention_held"] == 30_000


def test_bill_milestone_with_no_amount_completes_without_invoice():
    created = _new_project(contract_value=None)
    milestone_id = created["milestones"][0]["milestone_id"]
    _advance_to_signed_off(milestone_id)

    result = bill_milestone(milestone_id)

    assert result["billed"] is True
    assert result["invoice_id"] is None
    assert result["billed_amount"] is None


def test_close_project_requires_all_milestones_billed():
    created = _new_project()

    result = close_project(created["project_id"])

    assert result["closed"] is False


def test_close_project_releases_retention_and_closes():
    created = _new_project(contract_value=1_000_000)

    for milestone in created["milestones"]:
        _advance_to_signed_off(milestone["milestone_id"])
        bill_milestone(milestone["milestone_id"])

    result = close_project(created["project_id"])

    assert result["closed"] is True
    assert result["retention_released"] == 100_000  # 10% of 1,000,000 total
    assert result["invoice_id"] is not None

    project = find_project(created["project_id"])
    assert project["status"] == "CLOSED"
    assert project["retention_released"] is True


def test_close_project_cannot_double_close():
    created = _new_project(contract_value=None)

    for milestone in created["milestones"]:
        _advance_to_signed_off(milestone["milestone_id"])
        bill_milestone(milestone["milestone_id"])
    close_project(created["project_id"])

    second = close_project(created["project_id"])

    assert second["closed"] is False


def test_close_project_unknown_id():
    result = close_project("PRJ9999")

    assert result["closed"] is False


def test_list_projects_includes_new_project_newest_first():
    created = _new_project()

    projects = list_projects()

    assert projects[0]["project_id"] == created["project_id"]


def test_list_open_milestones_excludes_billed_includes_pending():
    created = _new_project()
    billed_milestone = created["milestones"][0]["milestone_id"]
    pending_milestone = created["milestones"][1]["milestone_id"]
    _advance_to_signed_off(billed_milestone)
    bill_milestone(billed_milestone)

    ids = {row["milestone_id"] for row in list_open_milestones()}

    assert pending_milestone in ids
    assert billed_milestone not in ids
