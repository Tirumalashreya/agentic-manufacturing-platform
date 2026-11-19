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

        # 6. Verify Oracle DOO 8-milestone tracker
        milestone_resp = await client.get(f"/api/v1/sales/orders/{order_id}/doo-milestones")
        assert milestone_resp.status_code == 200
        milestone_data = milestone_resp.json()
        assert milestone_data["total_milestones"] == 8
        milestones = milestone_data["milestones"]
        assert len(milestones) == 8
        assert milestones[0]["code"] == "ORDER_CAPTURED"
        assert milestones[1]["code"] == "CREDIT_VALIDATED"
        assert milestones[2]["code"] == "CTP_PROMISED"

        # 7. Test EDI 850 ingestion
        edi_payload = {
            "customer_po": "PO-BOEING-TEST-8800",
            "customer_name": "Boeing Aerospace",
            "material_sku": "PMP-500",
            "quantity": 25,
            "unit_price": 920.0
        }
        edi_resp = await client.post("/api/v1/sales/edi/ingest-850", json=edi_payload)
        assert edi_resp.status_code == 200
        edi_data = edi_resp.json()
        assert edi_data["status"] == "SUCCESS"
        edi_order_id = edi_data["order_id"]

        # 8. Test EDI 855 generation
        ack_resp = await client.get(f"/api/v1/sales/edi/generate-855/{edi_order_id}")
        assert ack_resp.status_code == 200
        ack_data = ack_resp.json()
        assert "ANSI X12" in ack_data["standard"]
        assert "BAK*00*AC*" in ack_data["edi_x12_payload"]
        assert "PO1*1*25*EA*920.00" in ack_data["edi_x12_payload"]
        assert "ACK*IA*25*EA*068*" in ack_data["edi_x12_payload"]
