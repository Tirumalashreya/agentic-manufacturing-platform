# app/integrations/manufacturing_services.py
"""
The Production Planning Agent's real connection to the existing TS
manufacturing microservices (order-service, routing-service, machine-
service, inventory-service, scheduling-service) — the first outbound HTTP
calls this codebase makes to any of them. This module is deliberately thin:
one function per real endpoint, no business logic, no retries beyond what
httpx gives for free — the same "compose already-existing, already-tested
operations" principle plan_executor.py already established for the mock-ERP
side, just over HTTP instead of in-process.

Every call is a plain async httpx request against a real endpoint that
already exists and is already used by other real callers (the setup-import
tool, or the services' own tests where they have them) — nothing here
invents a new capability on the TS side except get_bom, which mirrors an
endpoint added deliberately for this (see routing-service/src/index.ts).
"""
import base64
import hashlib
import hmac
import json
import os
import time

import httpx

from app.trace_context import get_trace_id
from app.config import (
    APS_PLATFORM_URL,
    INVENTORY_SERVICE_URL,
    MACHINE_SERVICE_URL,
    OPERATOR_SERVICE_URL,
    ORDER_SERVICE_URL,
    ROUTING_SERVICE_URL,
    SCHEDULING_SERVICE_URL,
)

_TIMEOUT = 15.0

# Stage 02 (Tenant Isolation + Service Identity): this process has no
# per-request human user or multi-tenant concept of its own — it is, by its
# current single-tenant design, always acting on behalf of the one real
# enterprise this whole demo system has ever operated against (see
# ARCHITECTURE_BASELINE.md's own verified finding on this). Rather than
# leaving that implicit, it's made explicit and configurable here, the same
# way MANUFACTURING_PLANT_ID already is (graph.py) — a real, deployer-set
# value, not a silent per-request fallback.
AGENT_ORCHESTRATOR_ENTERPRISE_ID = os.environ.get("AGENT_ORCHESTRATOR_ENTERPRISE_ID", "seed-enterprise")
# Must match packages/shared/src/serviceAuth.ts's requireIdentity() calls.
_IDENTITY_AUDIENCE = "aps-internal"


def _base64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _sign_identity_assertion(enterprise_id: str, secret: str, ttl_seconds: int = 60) -> str:
    """Python counterpart to packages/shared/src/identity.ts's
    signIdentityAssertion — produces byte-for-byte the same
    header.payload.signature format (base64url, HMAC-SHA256) so
    order-service/inventory-service's verifyIdentityAssertion can check it
    with no special-casing for which language minted it. This process has
    no human session to derive claims from, so it asserts its own fixed
    service identity (type="service", sub="agent-orchestrator") rather than
    forwarding anything caller-supplied."""
    now = int(time.time())
    header = _base64url(json.dumps({"alg": "HS256", "typ": "APS-IDENTITY"}, separators=(",", ":")).encode())
    payload = _base64url(json.dumps({
        "sub": "agent-orchestrator",
        "type": "service",
        "enterpriseId": enterprise_id,
        "aud": _IDENTITY_AUDIENCE,
        "iat": now,
        "exp": now + ttl_seconds,
    }, separators=(",", ":")).encode())
    signature = _base64url(hmac.new(secret.encode(), f"{header}.{payload}".encode(), hashlib.sha256).digest())
    return f"{header}.{payload}.{signature}"


# Auth/Authz hardening, Phase 1 (Finding 1.1): every TS service this module
# calls now requires the shared internal-service credential (see
# packages/shared/src/serviceAuth.ts) — passed as a default header on every
# client instance below rather than added per-call, so nothing here can
# accidentally omit it. APS Platform's own committing API routes
# (commit-production/reschedule/plan-production, called via APS_PLATFORM_URL
# below) accept this same header as proof the call is a real, already-
# approved server-to-server action (see web/src/lib/routeAuth.ts) — the
# PLANNER-or-above approval already happened upstream, at this process's own
# require_role("PLANNER") gate on the approval-resolve endpoints, before any
# of these calls are ever made.
#
# Stage 02: also attaches a signed identity assertion (see
# _sign_identity_assertion above) — order-service/inventory-service verify
# this independently of the shared token; every other service below simply
# ignores the extra header.
#
# Stage 07: also forwards the current run's trace_id (see
# app/trace_context.py) as x-trace-id, when one is set — every TS service's
# createApp() middleware (packages/shared/src/http.ts) echoes/logs whatever
# it receives here, so every outbound call this whole module makes, for the
# lifetime of one real run, is greppable under the same one id across every
# service's logs, with no change to any of the ~40 call sites below.
# Omitted (not an empty string) when no run is in scope — e.g. the demo
# ticker / health checks — so those keep minting their own fresh trace_id
# at the receiving end exactly as before.
def _internal_headers() -> dict[str, str]:
    token = os.environ.get("INTERNAL_SERVICE_TOKEN")
    if not token:
        raise RuntimeError("INTERNAL_SERVICE_TOKEN is not set — cannot call another internal service without it")
    headers = {
        "x-internal-token": token,
        "x-identity-assertion": _sign_identity_assertion(AGENT_ORCHESTRATOR_ENTERPRISE_ID, token),
    }
    trace_id = get_trace_id()
    if trace_id:
        headers["x-trace-id"] = trace_id
    return headers


async def get_bom(product_id: str) -> dict | None:
    """None means no active BOM exists for this product — a legitimate,
    honest result (see production_planning_agent's UNPLANNABLE verdict),
    not an error."""
    async with httpx.AsyncClient(timeout=_TIMEOUT, headers=_internal_headers()) as client:
        resp = await client.get(f"{ROUTING_SERVICE_URL}/boms/resolve", params={"productId": product_id})
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()


async def get_routing(product_id: str) -> dict | None:
    """None means no active routing exists for this product."""
    async with httpx.AsyncClient(timeout=_TIMEOUT, headers=_internal_headers()) as client:
        resp = await client.get(f"{ROUTING_SERVICE_URL}/routings/resolve", params={"productId": product_id})
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()


async def get_machine(machine_id: str) -> dict:
    """Used to turn a simulated/scheduled operation's raw machineId into a
    real machine name for display — the what-if/run responses only carry
    ids, not names."""
    async with httpx.AsyncClient(timeout=_TIMEOUT, headers=_internal_headers()) as client:
        resp = await client.get(f"{MACHINE_SERVICE_URL}/machines/{machine_id}")
    resp.raise_for_status()
    return resp.json()


async def get_operators() -> list[dict]:
    """Used by the Track Order panel to turn a ScheduledOperation's raw
    operatorId into a real name — same reasoning as get_machine, just no
    per-id route exists on operator-service, so this fetches the whole
    roster and the caller looks up by id (four names, not worth adding a
    new route for)."""
    async with httpx.AsyncClient(timeout=_TIMEOUT, headers=_internal_headers()) as client:
        resp = await client.get(f"{OPERATOR_SERVICE_URL}/operators")
    resp.raise_for_status()
    return resp.json()


async def get_vendors() -> list[dict]:
    """No vendor unit-cost data exists on the TS side (Vendor only has
    name/leadTimeDays/reliabilityScore) — the caller picks by lead time,
    deterministically, rather than needing an LLM cost/lead-time tradeoff
    the way the mock-ERP side's procurement_agent does."""
    async with httpx.AsyncClient(timeout=_TIMEOUT, headers=_internal_headers()) as client:
        resp = await client.get(f"{INVENTORY_SERVICE_URL}/vendors")
    resp.raise_for_status()
    return resp.json()


async def create_purchase_order(vendor_id: str, product_sku: str, quantity: int, expected_date: str) -> dict:
    async with httpx.AsyncClient(timeout=_TIMEOUT, headers=_internal_headers()) as client:
        resp = await client.post(
            f"{INVENTORY_SERVICE_URL}/purchase-orders",
            json={"vendorId": vendor_id, "productSku": product_sku, "quantity": quantity, "expectedDate": expected_date, "confirmed": True},
        )
    resp.raise_for_status()
    return resp.json()


async def get_inventory(product_id: str) -> list[dict]:
    async with httpx.AsyncClient(timeout=_TIMEOUT, headers=_internal_headers()) as client:
        resp = await client.get(f"{INVENTORY_SERVICE_URL}/inventory", params={"productId": product_id})
    resp.raise_for_status()
    return resp.json()


async def create_production_order(
    plant_id: str,
    product_id: str,
    routing_id: str | None,
    bom_id: str | None,
    quantity: int,
) -> dict:
    """order-service defaults status to PLANNED — this is the planning
    object, not a commitment. See delete_production_order for the reject
    path and update_production_order_status for the approve path."""
    async with httpx.AsyncClient(timeout=_TIMEOUT, headers=_internal_headers()) as client:
        resp = await client.post(
            f"{ORDER_SERVICE_URL}/orders",
            json={
                "plantId": plant_id,
                "productId": product_id,
                "routingId": routing_id,
                "bomId": bom_id,
                "quantity": quantity,
            },
        )
    resp.raise_for_status()
    return resp.json()


async def get_production_order(order_id: str) -> dict:
    async with httpx.AsyncClient(timeout=_TIMEOUT, headers=_internal_headers()) as client:
        resp = await client.get(f"{ORDER_SERVICE_URL}/orders/{order_id}")
    resp.raise_for_status()
    return resp.json()


async def update_production_order_status(order_id: str, status: str) -> dict:
    async with httpx.AsyncClient(timeout=_TIMEOUT, headers=_internal_headers()) as client:
        resp = await client.patch(f"{ORDER_SERVICE_URL}/orders/{order_id}", json={"status": status})
    resp.raise_for_status()
    return resp.json()


async def update_production_order_metadata(order_id: str, metadata: dict) -> dict:
    """Stores the sales-order/customer/pricing context that only Python's
    side knows (the TS order has no notion of a Python sales_order_id) —
    this is what lets the completion webhook (mes-integration ->
    /production-orders/{id}/complete) bill against the right sales order
    once the shop floor actually finishes it. Written right after RELEASE
    in _commit_production_plan, never before — there's nothing to bill
    until the plan is actually approved."""
    async with httpx.AsyncClient(timeout=_TIMEOUT, headers=_internal_headers()) as client:
        resp = await client.patch(f"{ORDER_SERVICE_URL}/orders/{order_id}", json={"metadata": metadata})
    resp.raise_for_status()
    return resp.json()


async def delete_production_order(order_id: str) -> None:
    """Real cascading delete (order-service's own DELETE /orders/:id) —
    used when a plan is rejected, so a PLANNED order never lingers."""
    async with httpx.AsyncClient(timeout=_TIMEOUT, headers=_internal_headers()) as client:
        resp = await client.delete(f"{ORDER_SERVICE_URL}/orders/{order_id}")
    resp.raise_for_status()


async def trigger_what_if_scheduling(plant_id: str) -> dict:
    """The pre-approval preview — real capacity-aware simulation, zero
    Postgres writes, zero effect on any other order's schedule (see
    scheduling-service/src/pipeline.ts's DryRunCtx). Never use
    trigger_scheduling_run for a preview — that one is a real, plant-wide
    commit."""
    async with httpx.AsyncClient(timeout=_TIMEOUT, headers=_internal_headers()) as client:
        resp = await client.post(
            f"{SCHEDULING_SERVICE_URL}/scheduling/what-if",
            json={"plantId": plant_id, "scope": "ALL", "mode": "FORWARD"},
        )
    resp.raise_for_status()
    return resp.json()


class APSAgentClient:
    """The real APS Agent client (agreed with the user) — the Sales Order
    Agent's structured interface to APS Platform's own apsAgent.ts module,
    not a bare set of unrelated HTTP calls. Every method here maps 1:1 to
    a named capability APS Platform's APS Agent actually owns (planning,
    commit, capacity/bottleneck status, what-if, and now reschedule/
    affected-orders preview) — this class only calls APS Platform; it
    never calls scheduling-service (or any other TS microservice)
    directly, so there is exactly one place in this whole codebase that
    knows how to talk to the APS Agent, not two divergent ones. The 14
    functions below this class remain direct-to-TS-service calls for
    master data/tracking — an intentionally different, unchanged
    category (see module docstring)."""

    async def plan_production(
        self,
        product_id: str,
        product_name: str | None,
        quantity: int,
        required_date: str | None,
        configuration_notes: str | None,
        idempotency_key: str | None = None,
    ) -> dict:
        """Pre-approval planning, relocated to APS Platform (agreed with
        the user) — this used to be agent-orchestrator calling
        routing-service, inventory-service, order-service,
        scheduling-service, and machine-service directly and assembling
        the plan itself. Same real calls to the same real services, just
        made by a genuinely separate application now; this call still
        happens synchronously inside the pre-approval flow, so "nothing
        before a human approves" is untouched — only who does the
        planning moved, not when.

        Stage 03C Part B: idempotency_key, when given, is relayed all the
        way to apsAgent.ts's real POST /orders call (order-service), so a
        timeout/retry of THIS SAME httpx call converges on one
        ProductionOrder instead of creating a duplicate. See
        _plan_production_via_manufacturing_services in graph.py for how
        the key is derived — a real business identity (the already-created
        sales order id + product + quantity), never LLM output."""
        async with httpx.AsyncClient(timeout=60.0, headers=_internal_headers()) as client:
            resp = await client.post(
                f"{APS_PLATFORM_URL}/api/plan-production",
                json={
                    "productId": product_id,
                    "productName": product_name,
                    "quantity": quantity,
                    "requiredDate": required_date,
                    "configurationNotes": configuration_notes,
                    "idempotencyKey": idempotency_key,
                },
            )
        resp.raise_for_status()
        return resp.json()

    async def commit_production(self, production_order_id: str, plant_id: str, billing_context: dict | None) -> dict:
        """Post-approval commit, relocated to APS Platform — the real
        counterpart to plan_production. Only ever called after a human
        has already approved on Ledger."""
        async with httpx.AsyncClient(timeout=30.0, headers=_internal_headers()) as client:
            resp = await client.post(
                f"{APS_PLATFORM_URL}/api/commit-production",
                json={"productionOrderId": production_order_id, "plantId": plant_id, "billingContext": billing_context},
            )
        resp.raise_for_status()
        return resp.json()

    async def capacity_status(self, plant_id: str) -> dict:
        """Real per-machine utilization and bottleneck flags, read
        straight from APS Platform's /api/capacity-status, which itself
        just relays scheduling-service's own real workload computation.
        Bottleneck identification is this same response's `bottlenecks`
        field — a separately-named capability in the milestone's target
        list, already satisfied here, not a new endpoint."""
        async with httpx.AsyncClient(timeout=15.0, headers=_internal_headers()) as client:
            resp = await client.get(f"{APS_PLATFORM_URL}/api/capacity-status", params={"plantId": plant_id})
        resp.raise_for_status()
        return resp.json()

    async def simulate(self, plant_id: str, production_order_id: str, capacity_adjustments: list[dict]) -> dict:
        """Real, non-committing what-if against a real capacity
        hypothetical. Nothing here is written; scheduling-service's own
        scratch namespace is torn down unconditionally on its side. Never
        touched by reschedule/AFFECTED work — no seed order is threaded
        into a what-if call."""
        async with httpx.AsyncClient(timeout=60.0, headers=_internal_headers()) as client:
            resp = await client.post(
                f"{APS_PLATFORM_URL}/api/simulate-schedule",
                json={"plantId": plant_id, "productionOrderId": production_order_id, "capacityAdjustments": capacity_adjustments},
            )
        resp.raise_for_status()
        return resp.json()

    async def resolve_affected_orders(self, plant_id: str, production_order_id: str, scope: str) -> dict:
        """Real, read-only preview of what a SINGLE/AFFECTED reschedule
        would actually touch — backed by scheduling-service's own
        resolveScopedOrderIds() (via APS Platform's
        /api/reschedule-preview), the exact same resolution the
        committing `reschedule` call below uses. Lets an approval gate
        (Ledger's pre-click preview, or the Agent Console's conversational
        approval card) show real target/affected order ids before
        anything commits, without ever defining "affected" a second,
        possibly-divergent way."""
        async with httpx.AsyncClient(timeout=15.0, headers=_internal_headers()) as client:
            resp = await client.get(
                f"{APS_PLATFORM_URL}/api/reschedule-preview",
                params={"plantId": plant_id, "productionOrderId": production_order_id, "scope": scope},
            )
        resp.raise_for_status()
        return resp.json()

    async def reschedule(self, plant_id: str, production_order_id: str, scope: str, mode: str) -> dict:
        """Real, committing — buildable now that scheduling-service's
        SINGLE/AFFECTED scope actually narrows to real orders instead of
        silently rescheduling the whole plant (see pipeline.ts's
        resolveScopedOrderIds). `scope` is required and NEVER defaulted
        to ALL by this method — the caller (sales_orders.py's REST
        endpoint for the Ledger UI button, or graph.py's reschedule node
        for a conversational request) always decides SINGLE vs AFFECTED
        explicitly before calling this; this is the one authoritative
        implementation both entry points converge on."""
        async with httpx.AsyncClient(timeout=60.0, headers=_internal_headers()) as client:
            resp = await client.post(
                f"{APS_PLATFORM_URL}/api/reschedule",
                json={"plantId": plant_id, "productionOrderId": production_order_id, "scope": scope, "mode": mode},
            )
        resp.raise_for_status()
        return resp.json()


aps_agent = APSAgentClient()

# Thin module-level aliases so every existing call site (graph.py,
# sales_orders.py, production.py) keeps working unmodified — the real
# capability interface now lives on `aps_agent` above; these are just
# familiar names delegating to it.
async def request_production_plan(
    product_id: str,
    product_name: str | None,
    quantity: int,
    required_date: str | None,
    configuration_notes: str | None,
    idempotency_key: str | None = None,
) -> dict:
    return await aps_agent.plan_production(
        product_id, product_name, quantity, required_date, configuration_notes, idempotency_key
    )


async def commit_production_plan(production_order_id: str, plant_id: str, billing_context: dict | None) -> dict:
    return await aps_agent.commit_production(production_order_id, plant_id, billing_context)


async def get_capacity_status(plant_id: str) -> dict:
    return await aps_agent.capacity_status(plant_id)


async def simulate_schedule(plant_id: str, production_order_id: str, capacity_adjustments: list[dict]) -> dict:
    return await aps_agent.simulate(plant_id, production_order_id, capacity_adjustments)


async def get_affected_orders_preview(plant_id: str, production_order_id: str, scope: str) -> dict:
    return await aps_agent.resolve_affected_orders(plant_id, production_order_id, scope)


async def reschedule_production_order(plant_id: str, production_order_id: str, scope: str, mode: str) -> dict:
    return await aps_agent.reschedule(plant_id, production_order_id, scope, mode)


# Phase 13 (Recovery What-If Simulation) — calls scheduling-service's own
# POST /scheduling/what-if DIRECTLY, not through the APS Platform bridge
# aps_agent.simulate()/reschedule() use. That endpoint already exists,
# already supports scope="AFFECTED"/mode="BOTTLENECK"+productionOrderId
# (confirmed by reading its real implementation — it was already hardened
# for exactly this combination, with its own scratch-Redis-namespace
# cleanup), and writes nothing (no ScheduleRun/ScheduledOperation/
# ResourceReservation — the same non-committing dry-run path real-run
# capacity placement uses, just never persisted). Same direct-to-
# scheduling-service convention get_quality_inspections/
# get_delay_explanation already use for read-only/non-committing calls —
# not a new integration pattern.
async def simulate_reschedule(plant_id: str, production_order_id: str, scope: str = "AFFECTED", mode: str = "BOTTLENECK") -> dict:
    async with httpx.AsyncClient(timeout=60.0, headers=_internal_headers()) as client:
        resp = await client.post(
            f"{SCHEDULING_SERVICE_URL}/scheduling/what-if",
            json={"plantId": plant_id, "scope": scope, "mode": mode, "productionOrderId": production_order_id, "capacityAdjustments": []},
        )
    resp.raise_for_status()
    return resp.json()


async def find_production_order_by_sales_order(sales_order_id: str) -> dict | None:
    """No metadata-filtered query exists on order-service — every
    ProductionOrder's Python-side sales_order_id only ever lives inside
    its own metadata JSON (see _commit_production_plan's billing_context
    write), so this reads the full list and filters here. Real data, not
    a new capability — GET /orders with no filters already returns every
    order across the one seeded plant, a small enough set for this to be
    honest and simple rather than adding a new filtered endpoint for one
    caller."""
    async with httpx.AsyncClient(timeout=15.0, headers=_internal_headers()) as client:
        resp = await client.get(f"{ORDER_SERVICE_URL}/orders")
    resp.raise_for_status()
    for order in resp.json():
        metadata = order.get("metadata") or {}
        if metadata.get("salesOrderId") == sales_order_id:
            return order
    return None


async def list_work_centers(plant_id: str) -> list[dict]:
    """Master data, same category as get_operators/get_machine — read
    directly from machine-service rather than through the APS bridge,
    matching the established pattern that only planning/commit/simulate
    (the actual decision-making calls) go through APS Platform."""
    async with httpx.AsyncClient(timeout=15.0, headers=_internal_headers()) as client:
        resp = await client.get(f"{MACHINE_SERVICE_URL}/work-centers", params={"plantId": plant_id})
    resp.raise_for_status()
    return resp.json()


async def check_shortages() -> dict:
    """Wraps the real, previously-uncalled POST /inventory/scan-shortages
    (Phase 8, agreed with the user) — real, plant-agnostic (the route
    itself has no plantId param; it scans every open PLANNED/RELEASED
    order across the one seeded plant), so this mirrors it exactly rather
    than inventing a filter the real endpoint doesn't support."""
    async with httpx.AsyncClient(timeout=_TIMEOUT, headers=_internal_headers()) as client:
        resp = await client.post(f"{INVENTORY_SERVICE_URL}/inventory/scan-shortages")
    resp.raise_for_status()
    return resp.json()


async def get_quality_inspections(plant_id: str) -> dict:
    """Wraps the real GET /scheduling/operations/quality-inspections
    (Phase 4's own list route) — recent real inspection results for a
    plant, unmodified."""
    async with httpx.AsyncClient(timeout=_TIMEOUT, headers=_internal_headers()) as client:
        resp = await client.get(
            f"{SCHEDULING_SERVICE_URL}/scheduling/operations/quality-inspections", params={"plantId": plant_id}
        )
    resp.raise_for_status()
    return resp.json()


async def get_quality_hold_status(scheduled_operation_id: str) -> dict:
    """Wraps the new GET /scheduling/operations/:id/quality-hold-status
    (Phase 8) — the exact same checkQcHold gate the Start-status PATCH
    already runs, exposed read-only. 404 means the operation id is real
    but doesn't exist; surfaced as None rather than raising, since a
    caller asking about a stale/mistyped id is a legitimate case, not a
    server error."""
    async with httpx.AsyncClient(timeout=_TIMEOUT, headers=_internal_headers()) as client:
        resp = await client.get(f"{SCHEDULING_SERVICE_URL}/scheduling/operations/{scheduled_operation_id}/quality-hold-status")
    if resp.status_code == 404:
        return {"blocked": False, "reason": None, "not_found": True}
    resp.raise_for_status()
    return resp.json()


async def get_delay_explanation(production_order_id: str) -> dict:
    """Wraps the new GET /scheduling/orders/:id/delay-explanation (Phase
    8) — a deterministic composition of real ScheduleAuditLog history,
    ProductionException history, QualityInspection/QC-hold status, and
    deviationMinutes for one order. No LLM on the TS side; the verdict-
    writer agent that consumes this only explains it."""
    async with httpx.AsyncClient(timeout=_TIMEOUT, headers=_internal_headers()) as client:
        resp = await client.get(f"{SCHEDULING_SERVICE_URL}/scheduling/orders/{production_order_id}/delay-explanation")
    if resp.status_code == 404:
        return {"not_found": True}
    resp.raise_for_status()
    return resp.json()


async def trigger_scheduling_run(plant_id: str) -> dict:
    """The real, committing run — only ever called after human approval.
    Reschedules the whole plant's open orders, exactly as this endpoint
    already behaves for every other caller; not a special case for this
    feature."""
    async with httpx.AsyncClient(timeout=_TIMEOUT, headers=_internal_headers()) as client:
        resp = await client.post(
            f"{SCHEDULING_SERVICE_URL}/scheduling/runs",
            json={"plantId": plant_id, "scope": "ALL", "mode": "FORWARD"},
        )
    resp.raise_for_status()
    return resp.json()
