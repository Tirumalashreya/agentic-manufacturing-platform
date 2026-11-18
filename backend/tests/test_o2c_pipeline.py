import pytest
from httpx import AsyncClient, ASGITransport
from app.main import app

@pytest.mark.anyio
async def test_o2c_full_lifecycle():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # 1. Check health
        health_resp = await client.get("/health")
        assert health_resp.status_code == 200
        assert health_resp.json()["status"] == "HEALTHY"

        # 2. Check customer master
        cust_resp = await client.get("/api/v1/sales/customers")
        assert cust_resp.status_code == 200
        customers = cust_resp.json()
        assert len(customers) > 0

        # 3. Evaluate RFQ
        rfq_payload = {"prompt": "Boeing Aerospace requests 10 units of Cable Management Kit needed next week"}
        rfq_resp = await client.post("/api/v1/sales/rfq/evaluate", json=rfq_payload)
        assert rfq_resp.status_code == 200
        proposal = rfq_resp.json()
        assert "token" in proposal
        assert proposal["credit_verified"] is True
        token = proposal["token"]

        # 4. Human Approval with CAS token
        appr_payload = {"token": token, "decision": "APPROVE", "approver": "vp.test@enterprise.com"}
        appr_resp = await client.post("/api/v1/sales/approvals/decide", json=appr_payload)
        assert appr_resp.status_code == 200
        appr_data = appr_resp.json()
        assert appr_data["status"] == "APPROVED"
        order_id = appr_data["order_id"]

        # 5. Verify 6-stage document flow (SAP VBFA)
        flow_resp = await client.get(f"/api/v1/sales/orders/{order_id}/flow")
        assert flow_resp.status_code == 200
        flow_data = flow_resp.json()
        stages = [s["stage"] for s in flow_data["document_flow"]]
        assert "RFQ_INTAKE" in stages
        assert "SALES_ORDER" in stages
        assert "CAPABLE_TO_PROMISE" in stages
        assert "PRODUCTION_ORDER" in stages
        assert "OUTBOUND_DELIVERY" in stages
        assert "BILLING_INVOICE" in stages
