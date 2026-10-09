# app/integrations/order_domain.py
"""
Order-to-production Phase 1 — the agent-orchestrator's dual-write into the
real Postgres order/fulfillment model (order-service), alongside the
existing mock-ERP SalesOrders sheet write (app/tools/sales_tools.py) that
every current channel page/read-path still depends on.

This is deliberately additive and best-effort: every function here is
called only after the real, existing mock-ERP order has already been
created, and a failure here must never fail or roll back that already-
committed order. Callers wrap these in try/except and treat a failure as
"the new Postgres fulfillment record wasn't written this time" — not as a
reason to fail the request. Same "compose already-existing HTTP calls, no
new business logic" principle as manufacturing_services.py.
"""
import httpx

from app.config import ORDER_SERVICE_URL

_TIMEOUT = 15.0


def _internal_headers() -> dict[str, str]:
    from app.integrations.manufacturing_services import _internal_headers as _headers
    return _headers()


async def find_or_create_customer(name: str) -> str:
    """The mock-ERP customer name is the only stable key this side has —
    reuses a real Customer row by exact name match instead of creating a
    duplicate one on every order."""
    async with httpx.AsyncClient(timeout=_TIMEOUT, headers=_internal_headers()) as client:
        resp = await client.get(f"{ORDER_SERVICE_URL}/customers", params={"name": name})
        resp.raise_for_status()
        existing = resp.json()
        if existing:
            return existing[0]["id"]

        resp = await client.post(f"{ORDER_SERVICE_URL}/customers", json={"name": name})
        resp.raise_for_status()
        return resp.json()["id"]


async def create_sales_order_with_fulfillment(
    customer_id: str,
    due_date: str,
    value: float,
    priority: int,
    order_number: str,
    channel: str,
    fulfillment_type: str,
    currency: str,
    created_by: str | None,
    external_order_id: str,
    product_id: str | None,
    product_name: str,
    quantity: float,
    unit_price: float,
    requested_date: str | None,
    strategy: str,
    reasoning: str | None,
    lines: list[dict],
    idempotency_key: str | None = None,
) -> dict:
    """Stage 03C Part C: the one atomic call that replaced the former
    create_sales_order_record + create_order_line_and_fulfillment pair —
    order-service's POST /sales-orders, extended (Stage 03A/B) to accept
    `lines`, already creates SalesOrder + OrderLine + FulfillmentPlan +
    FulfillmentLine(s) in a single Postgres transaction when `lines` is
    present. Two separate HTTP calls meant a real window where the first
    succeeded and the second failed (or, on a retry, duplicated) — this
    closes it by construction, not by added retry logic.

    idempotency_key, when given, is sent as the real Idempotency-Key
    header (the same claim-first mechanism this same endpoint already
    uses for Part A/B) — see _dual_write_order_and_fulfillment in graph.py
    for how it's derived from the approval run's own stable run_id.

    lines: [{"sourceType": "STOCK"|"PRODUCTION"|"BUY"|"DROP_SHIP"|"TRANSFER", "quantity": float, ...}].
    Returns the created SalesOrder plus {"orderLineId", "fulfillmentPlanId",
    "fulfillmentLines": [{"id", "sourceType"}]}."""
    headers = _internal_headers()
    if idempotency_key:
        headers = {**headers, "Idempotency-Key": idempotency_key}
    async with httpx.AsyncClient(timeout=_TIMEOUT, headers=headers) as client:
        resp = await client.post(
            f"{ORDER_SERVICE_URL}/sales-orders",
            json={
                "customerId": customer_id,
                "dueDate": due_date,
                "value": value,
                "priority": priority,
                "orderNumber": order_number,
                "channel": channel,
                "fulfillmentType": fulfillment_type,
                "status": "APPROVED",
                "currency": currency,
                "createdBy": created_by,
                "externalOrderId": external_order_id,
                "productId": product_id,
                "productName": product_name,
                "quantity": quantity,
                "unitPrice": unit_price,
                "requestedDate": requested_date,
                "strategy": strategy,
                "reasoning": reasoning,
                "lines": lines,
            },
        )
    resp.raise_for_status()
    return resp.json()


async def patch_fulfillment_line(
    fulfillment_line_id: str,
    production_order_id: str | None = None,
    execution_reference: str | None = None,
    status: str | None = None,
    promised_date: str | None = None,
    reason: str | None = None,
) -> None:
    body: dict = {}
    if production_order_id is not None:
        body["productionOrderId"] = production_order_id
    if execution_reference is not None:
        body["executionReference"] = execution_reference
    if status is not None:
        body["status"] = status
    if promised_date is not None:
        body["promisedDate"] = promised_date
    if reason is not None:
        body["reason"] = reason
    async with httpx.AsyncClient(timeout=_TIMEOUT, headers=_internal_headers()) as client:
        resp = await client.patch(f"{ORDER_SERVICE_URL}/fulfillment-lines/{fulfillment_line_id}", json=body)
    resp.raise_for_status()


async def get_fulfillment_by_external_order_id(external_order_id: str) -> dict | None:
    """Read side for GET /sales-orders/{id}/fulfillment — None means no
    real Postgres fulfillment record exists for this mock-ERP order
    (either it predates Phase 1, or the dual-write failed at creation
    time — both are honest, reportable states, not errors)."""
    async with httpx.AsyncClient(timeout=_TIMEOUT, headers=_internal_headers()) as client:
        resp = await client.get(f"{ORDER_SERVICE_URL}/sales-orders", params={"externalOrderId": external_order_id})
    resp.raise_for_status()
    orders = resp.json()
    return orders[0] if orders else None


async def get_promise_inbox(
    limit: int | None = None,
    offset: int | None = None,
    search: str | None = None,
    risk_status: str | None = None,
    pending_approval_only: bool | None = None,
) -> dict:
    """Phase 14 (Promise Risk & Decision Inbox) — pure passthrough to
    order-service's GET /sales-orders/promises (the real aggregation +
    deterministic classification endpoint; see packages/domain/src/
    promise-risk.ts and services/order-service/src/promise-inbox.ts).
    No reasoning happens here: this function exists only so the Ledger
    app's own API proxy (which forwards exclusively to this service, not
    order-service — see frontend/src/app/api/orchestrator/[...path]/
    route.ts) can reach it, same "compose an already-existing HTTP call"
    principle as every other function in this file."""
    params: dict[str, str] = {}
    if limit is not None:
        params["limit"] = str(limit)
    if offset is not None:
        params["offset"] = str(offset)
    if search:
        params["search"] = search
    if risk_status:
        params["riskStatus"] = risk_status
    if pending_approval_only:
        params["pendingApprovalOnly"] = "true"

    async with httpx.AsyncClient(timeout=_TIMEOUT, headers=_internal_headers()) as client:
        resp = await client.get(f"{ORDER_SERVICE_URL}/sales-orders/promises", params=params)
    resp.raise_for_status()
    return resp.json()
