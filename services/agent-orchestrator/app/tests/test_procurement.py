# app/tests/test_procurement.py
import pytest

from app.agents.procurement_agent import procurement_agent
from app.tools.procurement_tools import (
    check_material_availability,
    create_purchase_order,
    get_vendors_for_component,
)


def test_check_material_availability_no_bom():
    # P011 (Wireless Mouse) has no BOM row at all — should say so plainly,
    # not fake a shortage check.
    result = check_material_availability(product_id="P011", quantity=10)

    assert result["has_bom"] is False
    assert result["components"] == []


def test_check_material_availability_detects_real_shortage():
    # Laptop - Standard (P001) needs 1 CHASSIS per unit; ComponentInventory
    # has 25 in stock. 30 units should show a real 5-unit shortage on
    # CHASSIS, and no shortage on CPU (300 in stock, only needs 30).
    result = check_material_availability(product_id="P001", quantity=30)

    assert result["has_bom"] is True
    by_component = {c["component_id"]: c for c in result["components"]}
    assert by_component["CHASSIS"]["shortage"] == 5
    assert by_component["CPU"]["shortage"] == 0


def test_get_vendors_for_component_multiple_options():
    # CHASSIS deliberately has two vendors (cost/speed tradeoff) so
    # Procurement Agent has a real decision to make.
    vendors = get_vendors_for_component("CHASSIS")

    assert len(vendors) == 2
    vendor_ids = {v["vendor_id"] for v in vendors}
    assert vendor_ids == {"V004", "V005"}


def test_get_vendors_for_component_single_option():
    vendors = get_vendors_for_component("CPU")

    assert len(vendors) == 1
    assert vendors[0]["vendor_id"] == "V001"


def test_create_purchase_order_succeeds():
    result = create_purchase_order(
        production_order_id="PO0001",
        component_id="CHASSIS",
        component_name="Chassis (generic)",
        vendor_id="V005",
        vendor_name="RapidChassis Express",
        quantity=5,
        unit_cost=4200.0,
        lead_time_days=4,
    )

    assert result["created"] is True
    assert result["total_cost"] == 21000.0
    assert result["purchase_order_id"].startswith("PUR")


def test_create_purchase_order_rejects_bad_quantity():
    result = create_purchase_order(
        production_order_id="PO0001",
        component_id="CHASSIS",
        component_name="Chassis (generic)",
        vendor_id="V005",
        vendor_name="RapidChassis Express",
        quantity=0,
        unit_cost=4200.0,
        lead_time_days=4,
    )

    assert result["created"] is False


@pytest.mark.asyncio
async def test_procurement_agent_picks_only_vendor_when_one_exists():
    shortages = [{
        "component_id": "CPU",
        "component_name": "CPU (generic)",
        "shortage": 10,
        "vendors": [{"vendor_id": "V001", "vendor_name": "TechSource Components", "lead_time_days": 10, "unit_cost": 8000}],
    }]

    result = await procurement_agent(shortages=shortages, target_completion_date="2026-10-01")

    assert len(result.choices) == 1
    assert result.choices[0].vendor_id == "V001"


@pytest.mark.asyncio
async def test_procurement_agent_prefers_faster_vendor_under_tight_deadline():
    # Only 3 days until the target — the slow (14-day) vendor V004 cannot
    # possibly make it, only the fast (4-day) vendor V005 can.
    shortages = [{
        "component_id": "CHASSIS",
        "component_name": "Chassis (generic)",
        "shortage": 5,
        "vendors": [
            {"vendor_id": "V004", "vendor_name": "ChassisWorks", "lead_time_days": 14, "unit_cost": 2500},
            {"vendor_id": "V005", "vendor_name": "RapidChassis Express", "lead_time_days": 4, "unit_cost": 4200},
        ],
    }]

    import datetime
    tight_deadline = (datetime.date.today() + datetime.timedelta(days=3)).isoformat()

    result = await procurement_agent(shortages=shortages, target_completion_date=tight_deadline)

    assert result.choices[0].vendor_id == "V005"
