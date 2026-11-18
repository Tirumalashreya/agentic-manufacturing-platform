import pytest
from httpx import AsyncClient, ASGITransport
from app.main import app
from app.solver.mrp_engine import MultiLevelMRPEngine


def test_mrp_engine_deterministic_calculation():
    """
    Verifies that the MRP calculation engine explodes multi-level BOMs with scrap factors
    and calculates net requirements deterministically without floating-point errors.
    """
    materials_by_id = {
        "MAT-FINISHED": {"id": "MAT-FINISHED", "sku": "FIN-01", "name": "Assembly", "current_stock": 5.0, "safety_stock": 2.0, "standard_cost": 500.0, "material_type": "FINISHED"},
        "COMP-1": {"id": "COMP-1", "sku": "RAW-STL", "name": "Steel Bar", "current_stock": 100.0, "safety_stock": 20.0, "standard_cost": 10.0, "material_type": "RAW"},
        "COMP-2": {"id": "COMP-2", "sku": "RAW-BRG", "name": "Bearing", "current_stock": 10.0, "safety_stock": 15.0, "standard_cost": 25.0, "material_type": "RAW"},
    }
    materials_by_sku = {m["sku"]: m for m in materials_by_id.values()}

    boms_by_material_id = {
        "MAT-FINISHED": {
            "bom_id": "BOM-1",
            "items": [
                {"component_material_id": "COMP-1", "quantity_per": 2.0, "scrap_factor_pct": 5.0}, # 2 * 1.05 = 2.1
                {"component_material_id": "COMP-2", "quantity_per": 4.0, "scrap_factor_pct": 0.0}, # 4.0
            ]
        }
    }

    # Demand: 20 units of FIN-01
    demand_orders = [{"material_id": "MAT-FINISHED", "quantity": 20.0, "order_number": "SO-TEST-001"}]
    open_pos = {"COMP-2": 5.0} # 5 on the way
    suppliers = {"RAW-BRG": {"code": "VEND-SKF", "name": "SKF Bearings", "lead_time_days": 5, "unit_cost": 25.0}}

    result = MultiLevelMRPEngine.explode_and_calculate(
        demand_orders=demand_orders,
        materials_by_id=materials_by_id,
        materials_by_sku=materials_by_sku,
        boms_by_material_id=boms_by_material_id,
        open_pos_by_material_id=open_pos,
        suppliers_by_material_sku=suppliers,
    )

    assert result["demand_orders_count"] == 1
    assert result["components_analyzed"] == 2

    # For COMP-1 (Steel Bar):
    # Gross = 20 * 2.0 * 1.05 = 42.0
    # Available = 100 on hand + 0 inbound = 100
    # Gross + Safety = 42 + 20 = 62. Available = 100. Net req = 0 (Healthy)
    comp1 = next(item for item in result["items"] if item["sku"] == "RAW-STL")
    assert comp1["gross_requirement"] == 42.0
    assert comp1["net_requirement"] == 0.0
    assert comp1["status"] == "HEALTHY"

    # For COMP-2 (Bearing):
    # Gross = 20 * 4.0 = 80.0
    # On hand = 10.0, Inbound = 5.0 -> Available = 15.0
    # Safety stock = 15.0
    # Gross + Safety = 80 + 15 = 95.0. Net req = 95.0 - 15.0 = 80.0 shortage!
    comp2 = next(item for item in result["items"] if item["sku"] == "RAW-BRG")
    assert comp2["gross_requirement"] == 80.0
    assert comp2["net_requirement"] == 80.0
    assert comp2["status"] == "SHORTAGE_DETECTED"
    assert len(result["generated_purchase_requisitions"]) == 1
    assert result["generated_purchase_requisitions"][0]["quantity"] == 80.0


@pytest.mark.anyio
async def test_mrp_boms_api():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/api/v1/mrp/boms")
        assert resp.status_code == 200
        boms = resp.json()
        assert len(boms) >= 1
        cmk_bom = next(b for b in boms if b["sku"] == "CMK-100")
        assert len(cmk_bom["components"]) >= 3
        assert cmk_bom["bom_standard_cost"] > 0


@pytest.mark.anyio
async def test_mrp_run_and_po_lifecycle():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # 1. Execute MRP Run
        mrp_resp = await client.post("/api/v1/mrp/run")
        assert mrp_resp.status_code == 200
        mrp_data = mrp_resp.json()
        assert "components_analyzed" in mrp_data
        assert "items" in mrp_data

        # 2. List Purchase Orders
        po_resp = await client.get("/api/v1/mrp/purchase-orders")
        assert po_resp.status_code == 200
        pos = po_resp.json()
        assert len(pos) >= 1

        # 3. Approve a Draft PR into a Released PO
        target_po = next((p for p in pos if p["status"] == "DRAFT_PR"), pos[0])
        approve_resp = await client.post(f"/api/v1/mrp/purchase-orders/{target_po['id']}/approve")
        assert approve_resp.status_code == 200
        assert approve_resp.json()["status"] == "SUCCESS"
        assert approve_resp.json()["new_status"] == "RELEASED"

        # 4. Receive PO (Goods Receipt MIGO 101)
        receive_resp = await client.post(f"/api/v1/mrp/purchase-orders/{target_po['id']}/receive")
        assert receive_resp.status_code == 200
        assert receive_resp.json()["status"] == "SUCCESS"
        assert receive_resp.json()["new_status"] == "RECEIVED"
