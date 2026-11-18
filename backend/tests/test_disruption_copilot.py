import pytest
from httpx import AsyncClient, ASGITransport
from app.main import app

@pytest.mark.anyio
async def test_disruption_simulate_and_apply():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # 1. Simulate breakdown on CNC-01
        sim_payload = {"machine_code": "CNC-01", "downtime_hours": 3.5}
        sim_resp = await client.post("/api/v1/scheduling/disruption/simulate", json=sim_payload)
        assert sim_resp.status_code == 200
        analysis = sim_resp.json()
        assert "recommended_scenario" in analysis
        assert analysis["recommended_scenario"]["feasibility"] in ["HIGH", "MEDIUM", "FEASIBLE"]

        # 2. Apply mitigation
        apply_payload = {"machine_code": "CNC-01", "downtime_hours": 3.5, "action_type": "DYNAMIC_REROUTE"}
        apply_resp = await client.post("/api/v1/scheduling/disruption/apply", json=apply_payload)
        assert apply_resp.status_code == 200
        apply_data = apply_resp.json()
        assert apply_data["status"] == "SUCCESS"
