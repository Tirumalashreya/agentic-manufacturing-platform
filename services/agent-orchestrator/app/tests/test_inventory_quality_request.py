# app/tests/test_inventory_quality_request.py
"""
Phase 8 (agreed with the user) — the new Inventory/Quality/Delay
conversational trigger. Mirrors test_composed_execution.py's style: the
classifier is tested directly (pure function, no mocks needed); the node
is tested with mfg/inventory_agent/quality_agent patched, same as
process_agent is patched elsewhere, so these tests never make a real Groq
or HTTP call.
"""
from unittest.mock import AsyncMock, patch

import pytest

from app.graph import _classify_inventory_or_quality_request, _format_delay_explanation, composed_execution_router
from app.schemas.inventory_status import InventoryStatusDecision
from app.schemas.quality_status import QualityStatusDecision


def test_classifier_recognizes_shortage_language():
    assert _classify_inventory_or_quality_request("what's our inventory status for Cable Body", []) == "shortages"
    assert _classify_inventory_or_quality_request("are we short on stock", []) == "shortages"


def test_classifier_recognizes_quality_language():
    assert _classify_inventory_or_quality_request("did the last batch pass inspection", []) == "quality"
    assert _classify_inventory_or_quality_request("any quality issues today", []) == "quality"


def test_classifier_recognizes_delay_language():
    assert _classify_inventory_or_quality_request("why is order SO0004 delayed", []) == "delay"
    assert _classify_inventory_or_quality_request("is SO0004 running late", []) == "delay"


def test_classifier_ignores_unrelated_requests():
    assert _classify_inventory_or_quality_request("order 10 mice for ABC Corp", []) is None


def test_classifier_does_not_false_positive_on_late_as_a_substring():
    # "late" is checked with a word boundary specifically because a plain
    # substring match would misfire on words like "escalate"/"translate".
    assert _classify_inventory_or_quality_request("please escalate this order", []) is None
    assert _classify_inventory_or_quality_request("can you translate this note", []) is None


def test_reschedule_still_takes_precedence_over_inventory_quality_router():
    # composed_execution_router checks _classify_reschedule_request first —
    # this asserts adding the new classifier didn't change that existing
    # precedence (rule: existing routing must remain unchanged).
    state = {"user_message": "reschedule SO0001", "request_actions": []}
    assert composed_execution_router(state) == "reschedule_request"


def test_router_reaches_new_node_for_a_shortage_question():
    state = {"user_message": "what's our inventory status", "request_actions": [], "request_action_plan": []}
    assert composed_execution_router(state) == "inventory_quality_request"


def test_router_falls_through_to_process_for_unrelated_requests():
    state = {"user_message": "order 10 mice for ABC Corp", "request_actions": [], "request_action_plan": [], "intent": "service_request"}
    assert composed_execution_router(state) == "process"


@pytest.mark.asyncio
async def test_shortage_question_reports_a_real_ok_status_with_no_shortages():
    with patch("app.graph.mfg.check_shortages", new=AsyncMock(return_value={"shortages": []})), patch(
        "app.graph.inventory_agent",
        new=AsyncMock(return_value=InventoryStatusDecision(status="OK", explanation="No shortages found.")),
    ):
        from app.graph import inventory_quality_request_node

        result = await inventory_quality_request_node({"user_message": "what's our inventory status", "request_actions": []})

    assert result["status"] == "COMPLETED"
    assert result["response"] == "No shortages found."


@pytest.mark.asyncio
async def test_quality_question_reports_real_recent_inspections():
    inspections = {"items": [{"result": "FAIL", "operation": "Pack/Inspect", "inspectedAt": "2026-09-01T00:00:00Z"}]}
    with patch("app.graph.mfg.get_quality_inspections", new=AsyncMock(return_value=inspections)), patch(
        "app.graph.quality_agent",
        new=AsyncMock(return_value=QualityStatusDecision(status="RECENT_FAIL", explanation="A recent inspection failed.")),
    ):
        from app.graph import inventory_quality_request_node

        result = await inventory_quality_request_node({"user_message": "did the last batch pass inspection", "request_actions": []})

    assert result["status"] == "COMPLETED"
    assert result["response"] == "A recent inspection failed."


@pytest.mark.asyncio
async def test_delay_question_without_a_resolved_sales_order_asks_for_clarification():
    from app.graph import inventory_quality_request_node

    result = await inventory_quality_request_node(
        {"user_message": "why is my order delayed", "request_actions": [], "resolved_references": []}
    )

    assert result["needs_clarification"] is True
    assert result["status"] == "NEEDS_CLARIFICATION"


@pytest.mark.asyncio
async def test_delay_question_with_no_linked_production_order_reports_honestly():
    resolved_references = [
        {"reference": {"entity_type": "sales_order"}, "status": "RESOLVED", "resolved_record": {"sales_order_id": "SO0099"}}
    ]
    with patch("app.graph.mfg.find_production_order_by_sales_order", new=AsyncMock(return_value=None)):
        from app.graph import inventory_quality_request_node

        result = await inventory_quality_request_node(
            {"user_message": "why is SO0099 delayed", "request_actions": [], "resolved_references": resolved_references}
        )

    assert result["status"] == "COMPLETED"
    assert "SO0099" in result["response"]
    assert "no linked production order" in result["response"]


def test_delay_explanation_never_invents_a_reason_when_none_exists():
    # rule 8 — never invent a reason the real data doesn't support. Empty
    # operations/auditHistory must produce an honest "nothing found"
    # sentence, not a fabricated one.
    text = _format_delay_explanation("SO0001", {"latenessStatus": "ON_TRACK", "dueDate": None, "operations": [], "auditHistory": []})

    assert "No open exceptions, QC holds, or recorded reschedules were found" in text


def test_delay_explanation_surfaces_a_real_qc_hold():
    data = {
        "latenessStatus": "LATE",
        "dueDate": "2026-09-01T00:00:00Z",
        "operations": [
            {
                "operation": "Final Assembly",
                "qcHold": {"blocked": True, "reason": "Predecessor operation is on QC hold"},
                "recentExceptions": [],
                "deviationMinutes": None,
            }
        ],
        "auditHistory": [],
    }
    text = _format_delay_explanation("SO0001", data)

    assert "Final Assembly is blocked on a QC hold" in text
