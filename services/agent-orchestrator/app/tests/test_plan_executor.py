# app/tests/test_plan_executor.py
"""
Fully deterministic — no LLM anywhere. Tests execute_action_plan()
against real ERP data/tool calls for the exact allow-listed actions it
supports.
"""
from app.tools.plan_executor import (
    KNOWN_ACTIONS,
    execute_action_plan,
    execute_gated_action,
    is_known_action,
    plan_targets_order_creation,
)


def _context(**overrides):
    base = dict(
        # Large enough to stay valid regardless of how much live/manual
        # testing accumulates against C018's real exposure over time (see
        # the same fix in test_composed_execution.py).
        customer_id="C018", customer_name="Northgate Traders", customer_active=True,
        customer_credit_limit=100_000_000.0, product_id="P011", product_name="Wireless Mouse",
        quantity=5, price=800.0, requested_deadline=None,
    )
    base.update(overrides)
    return base


def test_check_credit_then_create_order_gates_for_approval():
    # create_order is in GATE_BEFORE — even once check_credit succeeds,
    # execution stops and waits for a real human decision instead of
    # creating the order automatically. Any plan that creates an order
    # is normalized to always run check_credit AND check_stock first
    # (see _normalize_plan) regardless of what the plan explicitly
    # listed, so both show up executed here even though only
    # check_credit was named in the plan.
    plan = [
        {"action": "check_credit", "depends_on": []},
        {"action": "create_order", "depends_on": ["check_credit"]},
    ]

    result = execute_action_plan(plan, _context())

    assert result["status"] == "AWAITING_APPROVAL"
    executed_actions = {e["action"] for e in result["executed"]}
    assert executed_actions == {"check_credit", "check_stock"}
    assert next(e for e in result["executed"] if e["action"] == "check_credit")["succeeded"] is True
    assert result["skipped"] == []
    assert result["pending_action"] == {"action": "create_order", "context": _context()}


def test_execute_gated_action_actually_creates_the_order():
    # The second half of the gate — only this call, made separately
    # after approval, ever writes the real order.
    result = execute_gated_action("create_order", _context())

    assert result["action"] == "create_order"
    assert result["succeeded"] is True
    assert result["result"]["created"] is True
    assert result["result"]["sales_order_id"] is not None


def test_execute_gated_action_rejects_non_gated_action():
    import pytest

    with pytest.raises(ValueError, match="not a gated action"):
        execute_gated_action("check_credit", _context())


def test_dependent_action_skipped_when_credit_check_fails():
    # A customer whose stated credit_limit is smaller than their real
    # accumulated exposure — check_credit legitimately fails, and
    # create_order must NOT be attempted since it depends on it.
    # check_stock still runs too (normalization forces it), but it's
    # non-blocking, so it isn't what's holding the order.
    plan = [
        {"action": "check_credit", "depends_on": []},
        {"action": "create_order", "depends_on": ["check_credit"]},
    ]

    result = execute_action_plan(plan, _context(customer_credit_limit=0.0))

    assert result["status"] == "PARTIAL"
    executed_actions = {e["action"] for e in result["executed"]}
    assert executed_actions == {"check_credit", "check_stock"}
    assert next(e for e in result["executed"] if e["action"] == "check_credit")["succeeded"] is False
    assert len(result["skipped"]) == 1
    assert result["skipped"][0]["action"] == "create_order"


def test_unknown_action_is_skipped_not_guessed():
    plan = [{"action": "arrange_financing", "depends_on": []}]

    result = execute_action_plan(plan, _context())

    assert result["status"] == "REJECTED"
    assert result["executed"] == []
    assert result["skipped"][0]["action"] == "arrange_financing"
    assert "not a supported composed action" in result["skipped"][0]["reason"]


def test_check_stock_action():
    plan = [{"action": "check_stock", "depends_on": []}]

    result = execute_action_plan(plan, _context(quantity=1))

    assert result["status"] == "COMPLETED"
    assert result["executed"][0]["result"]["sufficient"] is True


def test_check_stock_insufficient_still_reaches_the_approval_gate():
    # A real bug found live: this used to skip create_order outright on
    # insufficient stock, holding the order instead of creating it. That
    # was wrong once real fulfillment (MTO/HYBRID/THIRD_PARTY — see
    # graph.py's run_post_approval_fulfillment) exists to turn "not
    # enough on hand right now" into a real plan instead of a dead end.
    # check_stock's real result is still honestly reported (succeeded is
    # False) — it just no longer blocks create_order the way
    # check_credit failing does.
    # Credit limit raised so the huge quantity's dollar value still
    # clears check_credit — normalization now forces check_credit to run
    # too (see _normalize_plan), and it must not be what's blocking this
    # order; stock insufficiency is the thing under test here.
    plan = [
        {"action": "check_stock", "depends_on": []},
        {"action": "create_order", "depends_on": ["check_stock"]},
    ]
    context = _context(quantity=999_999_999, customer_credit_limit=10**15)

    result = execute_action_plan(plan, context)

    assert result["status"] == "AWAITING_APPROVAL"
    stock_outcome = next(e for e in result["executed"] if e["action"] == "check_stock")
    assert stock_outcome["succeeded"] is False
    credit_outcome = next(e for e in result["executed"] if e["action"] == "check_credit")
    assert credit_outcome["succeeded"] is True
    assert result["skipped"] == []
    assert result["pending_action"] == {"action": "create_order", "context": context}


def test_known_actions_matches_allow_list():
    assert "check_credit" in KNOWN_ACTIONS
    assert "check_stock" in KNOWN_ACTIONS
    assert "create_order" in KNOWN_ACTIONS
    assert len(KNOWN_ACTIONS) == 3


def test_prepare_order_alias_gates_exactly_like_create_order():
    # The exact bug found live: "prepare the order for my approval"
    # extracts action="prepare_order", which must gate identically to
    # "create_order" rather than silently falling through as unknown.
    plan = [
        {"action": "check_credit", "depends_on": []},
        {"action": "prepare_order", "depends_on": ["check_credit"]},
    ]

    result = execute_action_plan(plan, _context())

    assert result["status"] == "AWAITING_APPROVAL"
    assert result["pending_action"]["action"] == "create_order"


def test_is_known_action_recognizes_aliases():
    assert is_known_action("create_order") is True
    assert is_known_action("prepare_order") is True
    assert is_known_action("place_order") is True
    assert is_known_action("submit_order") is True
    assert is_known_action("arrange_financing") is False


def test_plan_targets_order_creation():
    assert plan_targets_order_creation([{"action": "create_order", "depends_on": []}]) is True
    assert plan_targets_order_creation([{"action": "prepare_order", "depends_on": []}]) is True
    assert plan_targets_order_creation([{"action": "check_credit", "depends_on": []}]) is False
    assert plan_targets_order_creation([]) is False
    assert plan_targets_order_creation(None) is False


def test_create_order_alone_gets_credit_and_stock_forced_in_front():
    # No check_credit/check_stock named at all — the real bug this fixes:
    # a plan reduced to just create_order (e.g. an unrecognized action
    # elsewhere in the plan meant nothing else survived) must still get
    # a real credit/stock picture before the approval gate, not just an
    # unconditioned pending_action.
    plan = [{"action": "create_order", "depends_on": []}]

    result = execute_action_plan(plan, _context())

    assert result["status"] == "AWAITING_APPROVAL"
    executed_actions = {e["action"] for e in result["executed"]}
    assert executed_actions == {"check_credit", "check_stock"}
    assert result["pending_action"]["context"] == _context()
