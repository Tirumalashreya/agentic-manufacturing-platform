# app/tools/plan_executor.py
"""
Phase 3 (agreed with the user, built on real evidence — Phase 2.3's
action_plan schema, whose own worked example was exactly "check credit,
and if within limit, place the order"): a narrow, explicit-allow-list
composer, NOT a general planner. It composes only already-existing,
already-tested operations (erp.check_credit, erp.create_sales_order,
erp.get_stock) in the dependency order the customer actually stated — no
business rule lives here that doesn't already live in those operations,
matching the roadmap's own "the planner composes existing trusted
operations; the actual business rules remain inside those operations"
principle. Any action label outside this small allow-list is reported as
skipped/unsupported, never guessed at or improvised.
"""
from app.erp.mock_erp_adapter import default_erp_adapter as erp


def _run_check_credit(ctx: dict) -> dict:
    amount = (ctx.get("quantity") or 0) * (ctx.get("price") or 0)
    return erp.check_credit(
        customer_id=ctx.get("customer_id"),
        credit_limit=ctx.get("customer_credit_limit"),
        new_order_amount=amount,
        exclude_sales_order_id=None,
    )


def _check_credit_succeeded(result: dict) -> bool:
    return bool(result.get("within_credit"))


def _run_check_stock(ctx: dict) -> dict:
    rows = erp.get_stock(ctx.get("product_id"))
    total = sum(row["stock_qty"] for row in rows)
    return {"stock_total": total, "sufficient": total >= (ctx.get("quantity") or 0)}


def _check_stock_succeeded(result: dict) -> bool:
    return bool(result.get("sufficient"))


def _run_create_order(ctx: dict) -> dict:
    return erp.create_sales_order(
        customer_id=ctx.get("customer_id"),
        customer_name=ctx.get("customer_name"),
        customer_active=bool(ctx.get("customer_active")),
        product_id=ctx.get("product_id"),
        product_name=ctx.get("product_name"),
        quantity=ctx.get("quantity"),
        unit_price=ctx.get("price"),
        requested_deadline=ctx.get("requested_deadline"),
    )


def _create_order_succeeded(result: dict) -> bool:
    return bool(result.get("created"))


# action label -> (runner, success predicate). Deliberately tiny — every
# entry here is a direct call to a real, already-tested tool function;
# adding a new label means adding a new real capability, not a new rule.
_ALLOW_LIST = {
    "check_credit": (_run_check_credit, _check_credit_succeeded),
    "check_stock": (_run_check_stock, _check_stock_succeeded),
    "create_order": (_run_create_order, _create_order_succeeded),
}

KNOWN_ACTIONS = tuple(_ALLOW_LIST.keys())

# request_understanding_agent picks its own short label for "create the
# order" based on the customer's actual wording ("place the order" ->
# create_order, "prepare the order for my approval" -> prepare_order,
# ...) — same action underneath either way. Normalizing synonyms here
# keeps the LLM free to describe the request naturally instead of having
# to memorize one exact canonical verb, without expanding the real
# allow-list (KNOWN_ACTIONS/GATE_BEFORE stay exactly 3 entries).
_ACTION_ALIASES = {
    "prepare_order": "create_order",
    "place_order": "create_order",
    "submit_order": "create_order",
}


def _canonical_action(label: str | None) -> str | None:
    return _ACTION_ALIASES.get(label, label)


# What composed_execution_router actually gates its whole-plan check on
# — must agree with what execute_action_plan() below will accept, or a
# plan using a recognized synonym would pass the router's check but then
# get treated as unknown here (or vice versa).
def is_known_action(label: str | None) -> bool:
    return _canonical_action(label) in _ALLOW_LIST


# What composed_execution_router actually gates the whole human-approval
# path on. A real bug found live TWICE now:
#
# First time: a paraphrased request ("check everything and prepare the
# order for approval") had the LLM extract an action label the allow-list
# didn't recognize alongside create_order's own alias — under the
# router's old "every action in the plan must be a known one, and there
# must be 2+" rule, that single unrecognized label failed the whole plan
# and the request fell through to the old, ungated direct_sales path,
# silently creating the order with no human approval step at all. Fixed
# by _normalize_plan below (check_credit/check_stock/create_order
# synthesized regardless of what else was in the plan) — but that fix
# only ever runs once this function has already said yes.
#
# Second time (this fix): the LLM labeled the final step "prepare_units"
# — not "create_order" and not one of the three known aliases — so this
# function itself said no, and the request never reached _normalize_plan
# at all, same ungated fallthrough as before, just one step earlier. A
# fixed string alias list can never keep up with how many ways an LLM can
# phrase "get this ready" — so this no longer depends solely on the
# action_plan's own labels. `intent`, when given, is intent_agent's own
# classification (a small, controlled enum — not free text this function
# has to keep relearning synonyms for) and is trusted directly: if the
# Sales Order Agent's own intent classification says this request is
# creating an order, the human-approval guarantee applies, regardless of
# what label request_understanding_agent happened to pick for the same
# thing.
def plan_targets_order_creation(action_plan: list[dict], intent: str | None = None) -> bool:
    if intent == "create_order":
        return True
    return any(_canonical_action(step.get("action")) == "create_order" for step in (action_plan or []))


def _normalize_plan(action_plan: list[dict], intent: str | None = None) -> list[dict]:
    """
    Whenever the plan would create an order, check_credit and check_stock
    are forced to run first — and create_order's dependencies are forced
    to be exactly those two — regardless of what the LLM's own plan
    actually said. This keeps the credit/stock preview on the approval
    card, and the credit hard-gate underneath it, true by construction
    instead of contingent on the request happening to be phrased in a way
    that extracts the "right" multi-step plan. `intent` is threaded
    through to the same real-intent fallback plan_targets_order_creation
    uses — a plan with no recognized create_order-shaped step still gets
    the real check_credit/check_stock/create_order triad synthesized
    below when intent_agent already classified this as create_order.
    """
    if not plan_targets_order_creation(action_plan, intent):
        return action_plan

    by_label: dict[str, dict] = {}
    others: list[dict] = []
    for step in action_plan:
        label = _canonical_action(step.get("action"))
        if label in ("check_credit", "check_stock"):
            by_label.setdefault(label, {"action": label, "depends_on": []})
        elif label != "create_order":
            others.append(step)

    prerequisites = [by_label.get(label, {"action": label, "depends_on": []}) for label in ("check_credit", "check_stock")]
    create_order_step = {"action": "create_order", "depends_on": ["check_credit", "check_stock"]}
    return prerequisites + others + [create_order_step]


# check_stock failing must NOT block create_order the way check_credit
# failing does — a real bug found live: "not enough on hand right now"
# was skipping the order entirely instead of letting it through to the
# real fulfillment decision (see graph.py's run_post_approval_fulfillment),
# whose whole job is turning insufficient stock into MTO/HYBRID/
# THIRD_PARTY instead of a dead end. check_stock's real result (sufficient
# or not) still gets reported honestly — it just no longer gates whether
# the order gets created. check_credit staying a hard gate is correct:
# a customer who can't afford the order should not get one created at all.
NON_BLOCKING_DEPENDENCIES = frozenset({"check_stock"})

# Actions that must never run automatically — once every dependency has
# succeeded, execution genuinely stops here and waits for a separate,
# explicit human decision (see execute_gated_action below) instead of
# proceeding. This is a real pause, not a UI animation: nothing in this
# module calls erp.create_sales_order until a human-approved follow-up
# request does. Matches this codebase's own established pattern (the
# Financial Adjustment approval gate) applied to composed order creation
# for the first time.
GATE_BEFORE = frozenset({"create_order"})


def execute_action_plan(action_plan: list[dict], context: dict, intent: str | None = None) -> dict:
    """
    action_plan: [{"action": str, "depends_on": list[str]}, ...] — see
    RequestedAction. context: resolved fields the allow-listed actions
    need (customer_id, customer_name, customer_active,
    customer_credit_limit, product_id, product_name, quantity, price,
    requested_deadline) — the same fields context_node already resolves.
    intent: intent_agent's own classification, threaded through to
    _normalize_plan's real-intent fallback — see plan_targets_order_creation's
    doc comment for why this matters (a paraphrased final action label the
    allow-list doesn't recognize must not silently skip the human-approval
    gate).

    Executes in list order (the action_plan is small and short-lived —
    no topological sort needed). An action whose dependencies didn't all
    succeed is skipped, not attempted; an action outside the allow-list
    is skipped with an explicit reason, never guessed at. An action in
    GATE_BEFORE whose dependencies DID all succeed is not run — it's
    reported as `pending_action` and execution stops there, awaiting a
    real human decision via execute_gated_action().
    """
    action_plan = _normalize_plan(action_plan, intent)

    outcomes: dict[str, dict] = {}
    executed = []
    skipped = []
    pending_action: dict | None = None

    for step in action_plan:
        raw_label = step.get("action")
        label = _canonical_action(raw_label)
        deps = [_canonical_action(d) for d in (step.get("depends_on") or [])]

        if label not in _ALLOW_LIST:
            skipped.append({"action": raw_label, "reason": f"'{raw_label}' is not a supported composed action."})
            continue

        unmet = [
            d for d in deps
            if d not in NON_BLOCKING_DEPENDENCIES and not outcomes.get(d, {}).get("succeeded")
        ]
        if unmet:
            skipped.append({"action": label, "reason": f"Skipped — depends on {unmet}, which did not succeed."})
            continue

        if label in GATE_BEFORE:
            pending_action = {"action": label, "context": context}
            break

        run_fn, success_fn = _ALLOW_LIST[label]
        result = run_fn(context)
        succeeded = success_fn(result)
        outcomes[label] = {"result": result, "succeeded": succeeded}
        executed.append({"action": label, "result": result, "succeeded": succeeded})

    if pending_action is not None:
        status = "AWAITING_APPROVAL"
    elif not executed:
        status = "REJECTED"
    elif skipped or not all(e["succeeded"] for e in executed):
        status = "PARTIAL"
    else:
        status = "COMPLETED"

    return {"status": status, "executed": executed, "skipped": skipped, "pending_action": pending_action}


def execute_gated_action(action: str, context: dict) -> dict:
    """
    The other half of the approval gate: actually runs a GATE_BEFORE
    action, called only after a real human approval (see
    app/routers/approvals.py). `action`/`context` are exactly what
    execute_action_plan() returned in `pending_action` — nothing is
    re-derived or re-guessed here, the same resolved data the human saw
    in the approval preview is what actually gets executed.
    """
    if action not in GATE_BEFORE:
        raise ValueError(f"'{action}' is not a gated action — nothing to approve here.")
    run_fn, success_fn = _ALLOW_LIST[action]
    result = run_fn(context)
    return {"action": action, "result": result, "succeeded": success_fn(result)}
