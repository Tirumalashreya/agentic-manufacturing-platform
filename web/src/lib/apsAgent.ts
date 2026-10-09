// The real APS Agent — the genuine domain-specialist interface between
// the Sales Order Agent (agent-orchestrator, via manufacturing_services.py's
// APSAgentClient) and this app's existing deterministic engine/services.
// Not a renamed HTTP wrapper: every method here is a named capability
// (planProduction, commitProduction, getCapacityStatus, simulateWhatIf,
// reschedule, resolveAffectedOrders), each composing calls to the
// existing TS microservices exactly as before — this module OWNS that
// composition logic; the API routes under app/api/* are now thin
// delegates to it, not where the logic lives. No LLM anywhere in this
// file, and no scheduling math of its own — every real decision (what's
// feasible, what's scheduled, what's affected) still comes from routing-
// service/inventory-service/order-service/scheduling-service/machine-service,
// the existing deterministic APS engine underneath. This module only
// composes and interprets those real answers.
import { internalServiceHeaders } from "@aps/shared/serviceAuth";
import { signIdentityAssertion } from "@aps/shared/identity";

// Auth/Authz hardening, Phase 1 (Finding 1.1) — see services.ts's identical
// wrapper doc comment; this module is APS's other real caller of the
// backend services, so it needs the same credential on every call.
//
// Stage 02 (Tenant Isolation + Service Identity): this module is called
// from app/api/aps/* routes reached EITHER by a real browser session OR by
// agent-orchestrator server-to-server (see routeAuth.ts's
// requireSessionOrServiceCaller) — there is no session to mint a user
// identity assertion from in the second case, and every method here
// already operates on the one real, fixed MANUFACTURING_PLANT_ID below,
// not a caller-supplied plant. So this mints a service-level assertion
// for its own fixed enterprise, same pattern and same reasoning as
// manufacturing_services.py's AGENT_ORCHESTRATOR_ENTERPRISE_ID — not a
// per-request fallback, a real statement of which enterprise this
// module's one real plant has always belonged to.
const MANUFACTURING_ENTERPRISE_ID = process.env.MANUFACTURING_ENTERPRISE_ID ?? "seed-enterprise";

// Stage 07 (Observability/Correlation): traceId, when given, is forwarded
// as x-trace-id — every TS service's createApp() middleware
// (packages/shared/src/http.ts) echoes/logs whatever it receives, so a
// call chain starting at agent-orchestrator (which sets this on its own
// outbound calls, see app/trace_context.py) stays correlated all the way
// through APS Platform and into whichever of the 5 TS services below a
// given method calls. Omitted when absent — e.g. a direct browser-session
// call with no upstream run_id — exactly as every other optional header
// here already behaves.
function internalFetch(input: string, init: RequestInit = {}, traceId?: string | null): Promise<Response> {
  const identityHeader = {
    "x-identity-assertion": signIdentityAssertion(
      { sub: "aps-platform", type: "service" as const, enterpriseId: MANUFACTURING_ENTERPRISE_ID, aud: "aps-internal" },
      process.env.INTERNAL_SERVICE_TOKEN ?? ""
    ),
  };
  const traceHeader: Record<string, string> = traceId ? { "x-trace-id": traceId } : {};
  return fetch(input, { ...init, headers: { ...init.headers, ...internalServiceHeaders(), ...identityHeader, ...traceHeader } });
}

const ROUTING_SERVICE_URL = process.env.ROUTING_SERVICE_URL ?? "http://localhost:4002";
const MACHINE_SERVICE_URL = process.env.MACHINE_SERVICE_URL ?? "http://localhost:4008";
const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL ?? "http://localhost:4001";
const SCHEDULING_SERVICE_URL = process.env.SCHEDULING_SERVICE_URL ?? "http://localhost:4005";
const INVENTORY_SERVICE_URL = process.env.INVENTORY_SERVICE_URL ?? "http://localhost:4010";
const MANUFACTURING_PLANT_ID = process.env.MANUFACTURING_PLANT_ID ?? "cmttuotng0000xucaila9ze65";
const BOTTLENECK_THRESHOLD_PCT = 90; // matches WorkloadGraph's own established red-threshold convention

type Material = { component_id: string; component_name: string; required: number; available: number; shortage: number };
type RoutingOp = { operation_id: string; operation: string; op_number: number; work_center_code: string };

class APSAgent {
  // Unchanged behavior from the prior /api/plan-production route (moved,
  // not rewritten) — see the route file for why this is where it stayed
  // instead of agent-orchestrator, and why it's a real side-effecting
  // call (creates a real ProductionOrder) rather than a pure preview.
  async planProduction(params: {
    productId: string;
    productName: string | null;
    quantity: number;
    configurationNotes: string | null;
    idempotencyKey?: string | null;
    traceId?: string | null;
  }) {
    const { productId, productName, quantity, configurationNotes, idempotencyKey, traceId } = params;
    // Scoped to this call chain only — every internalFetch below in this
    // method forwards the same traceId, without changing internalFetch's
    // default behavior for every other method in this class.
    const fetchWithTrace = (input: string, init?: RequestInit) => internalFetch(input, init, traceId);

    const [bomRes, routingRes] = await Promise.all([
      fetchWithTrace(`${ROUTING_SERVICE_URL}/boms/resolve?productId=${encodeURIComponent(productId)}`),
      fetchWithTrace(`${ROUTING_SERVICE_URL}/routings/resolve?productId=${encodeURIComponent(productId)}`),
    ]);
    const bom = bomRes.ok ? await bomRes.json() : null;
    const routing = routingRes.ok ? await routingRes.json() : null;

    if (!bom && !routing) {
      // Phase 2 (agreed with the user): renamed from "UNPLANNABLE" — a
      // genuine configuration/master-data gap (Cause 1), never a
      // scheduling-capacity problem (Cause 2, which gets its own real
      // classification downstream in graph.py once a plan actually
      // exists). No scheduling call happens for this cause, so no
      // extended-horizon lookahead ever runs here — correct by construction,
      // not by a separate check.
      return {
        verdict: "PLANNING_CONFIGURATION_ISSUE",
        explanation: `No BOM or routing exists for ${productName ?? productId} — production cannot be planned.`,
        materials: [],
        routing_operations: [],
        simulated_operations: [],
        production_order_id: null,
        plant_id: MANUFACTURING_PLANT_ID,
        configuration_notes: configurationNotes,
        procurement_plan: [],
        quantity,
      };
    }

    const materials: Material[] = [];
    if (bom) {
      for (const line of bom.lines as { componentId: string; component: { family: string }; quantityPer: number }[]) {
        const invRes = await fetchWithTrace(`${INVENTORY_SERVICE_URL}/inventory?productId=${encodeURIComponent(line.componentId)}`);
        const invRows = invRes.ok ? ((await invRes.json()) as { qtyUnrestricted: number }[]) : [];
        const available = invRows.reduce((sum, row) => sum + row.qtyUnrestricted, 0);
        const required = line.quantityPer * quantity;
        materials.push({
          component_id: line.componentId,
          component_name: line.component.family,
          required,
          available,
          shortage: Math.max(required - available, 0),
        });
      }
    }

    const routingOperations: RoutingOp[] = routing
      ? (routing.operations as { id: string; operation: string; opNumber: number; workCenter: { code: string } }[]).map((op) => ({
          operation_id: op.id,
          operation: op.operation,
          op_number: op.opNumber,
          work_center_code: op.workCenter.code,
        }))
      : [];

    // Stage 03C Part B: forwards the agent-orchestrator's real, request-
    // derived Idempotency-Key, when one was sent, so a timeout/retry of
    // this same POST (this whole planProduction call has no retry logic
    // of its own today, but a caller-level retry does happen at the
    // graph.py layer) converges on one ProductionOrder instead of two.
    // Omitted entirely for any caller that doesn't send one — order-service
    // treats a missing header exactly as it always has.
    const orderRes = await fetchWithTrace(`${ORDER_SERVICE_URL}/orders`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: JSON.stringify({
        plantId: MANUFACTURING_PLANT_ID,
        productId,
        routingId: routing?.id ?? null,
        bomId: bom?.id ?? null,
        quantity,
      }),
    });
    const order = await orderRes.json();
    const productionOrderId = order.id as string;

    const schedRes = await fetchWithTrace(`${SCHEDULING_SERVICE_URL}/scheduling/what-if`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plantId: MANUFACTURING_PLANT_ID, scope: "ALL", mode: "FORWARD" }),
    });
    const scheduleResult = await schedRes.json();
    const mySimOps = ((scheduleResult.simulatedOperations ?? []) as { productionOrderId: string; machineId: string; routingOperationId: string; scheduledStart: string; scheduledEnd: string; viaExtendedHorizon?: boolean }[])
      .filter((op) => op.productionOrderId === productionOrderId);

    const opById = new Map(routingOperations.map((o) => [o.operation_id, o]));
    const simulatedOperations = [];
    for (const op of mySimOps) {
      const machineRes = await fetchWithTrace(`${MACHINE_SERVICE_URL}/machines/${op.machineId}`);
      const machine = machineRes.ok ? await machineRes.json() : null;
      const routingOp = opById.get(op.routingOperationId);
      simulatedOperations.push({
        operation: routingOp?.operation ?? "?",
        machine_id: op.machineId,
        machine_name: machine?.name ?? "?",
        scheduled_start: op.scheduledStart,
        scheduled_end: op.scheduledEnd,
        via_extended_horizon: op.viaExtendedHorizon === true,
      });
    }

    // Phase 2 (agreed with the user): real deterministic facts about
    // schedulability — scheduling-service's own FORWARD-mode placement
    // loop already retried once at EXTENDED_HORIZON_DAYS internally (see
    // pipeline.ts) before giving up on any operation, so these numbers
    // already reflect that retry; nothing extra to call here. Named
    // distinctly from `materials`' shortage fields so a caller (or a
    // human reading the JSON) never conflates "couldn't get parts" with
    // "couldn't get a machine slot" — two different real causes.
    const operationsNotPlaced = routingOperations.length - simulatedOperations.length;
    const neededExtendedHorizon = simulatedOperations.some((op) => op.via_extended_horizon);

    const hasShortage = materials.some((m) => m.shortage > 0);
    const procurementPlan: { component_id: string; component_name: string; quantity: number; vendor_id: string; vendor_name: string; lead_time_days: number; expected_date: string }[] = [];
    if (hasShortage) {
      // Real per-component vendor selection (Phase 7, agreed with the
      // user) — previously this fetched the global vendor list ONCE and
      // reused vendors[0] (lowest overall leadTimeDays) for every shortage
      // line regardless of which component it was. Now each component
      // asks specifically "who sells THIS component" (GET /vendors?productId=,
      // real VendorProduct data, Phase 7) and falls back to the old
      // global-cheapest behavior only when no per-component data exists
      // yet — same additive, no-regression-for-unconfigured-cases pattern
      // used throughout this session.
      let globalVendors: { id: string; name: string; leadTimeDays: number }[] | null = null;
      for (const m of materials) {
        if (m.shortage <= 0) continue;
        const perComponentRes = await fetchWithTrace(`${INVENTORY_SERVICE_URL}/vendors?productId=${encodeURIComponent(m.component_id)}`);
        const perComponentVendors = perComponentRes.ok
          ? ((await perComponentRes.json()) as { id: string; name: string; leadTimeDays: number }[])
          : [];
        let vendor = perComponentVendors[0];
        if (!vendor) {
          if (globalVendors === null) {
            const vendorsRes = await fetchWithTrace(`${INVENTORY_SERVICE_URL}/vendors`);
            globalVendors = vendorsRes.ok ? ((await vendorsRes.json()) as { id: string; name: string; leadTimeDays: number }[]) : [];
          }
          vendor = globalVendors[0]; // already sorted by leadTimeDays asc (inventory-service's GET /vendors)
        }
        if (!vendor) continue;
        const expectedDate = new Date(Date.now() + vendor.leadTimeDays * 86_400_000).toISOString().slice(0, 10);
        procurementPlan.push({
          component_id: m.component_id,
          component_name: m.component_name,
          quantity: m.shortage,
          vendor_id: vendor.id,
          vendor_name: vendor.name,
          lead_time_days: vendor.leadTimeDays,
          expected_date: expectedDate,
        });
      }
    }

    return {
      materials,
      routing_operations: routingOperations,
      simulated_operations: simulatedOperations,
      production_order_id: productionOrderId,
      plant_id: MANUFACTURING_PLANT_ID,
      configuration_notes: configurationNotes,
      procurement_plan: procurementPlan,
      quantity,
      has_shortage: hasShortage,
      scheduling_conflicts_detected: scheduleResult.conflictsDetected ?? 0,
      operations_not_placed: operationsNotPlaced,
      needed_extended_horizon: neededExtendedHorizon,
    };
  }

  // Unchanged behavior from the prior /api/commit-production route.
  async commitProduction(params: { productionOrderId: string; plantId: string; billingContext?: Record<string, unknown> | null }) {
    const { productionOrderId, plantId, billingContext } = params;

    await internalFetch(`${ORDER_SERVICE_URL}/orders/${productionOrderId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "RELEASED" }),
    });

    if (billingContext) {
      // realSalesOrderId (order-to-production Phase 1): the real Postgres
      // SalesOrder.id, when the agent-orchestrator's dual-write succeeded —
      // sets the genuine FK alongside the existing metadata.salesOrderId
      // string (kept for backward compatibility with existing scanning
      // code, e.g. find_production_order_by_sales_order).
      const { realSalesOrderId, ...metadata } = billingContext as Record<string, unknown> & { realSalesOrderId?: string };
      await internalFetch(`${ORDER_SERVICE_URL}/orders/${productionOrderId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ metadata, salesOrderId: realSalesOrderId ?? undefined }),
      });
    }

    await internalFetch(`${SCHEDULING_SERVICE_URL}/scheduling/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plantId, scope: "ALL", mode: "FORWARD" }),
    });

    const orderRes = await internalFetch(`${ORDER_SERVICE_URL}/orders/${productionOrderId}`);
    const order = await orderRes.json();

    return {
      production_order_id: productionOrderId,
      status: order.status,
      scheduled_operations: order.scheduledOperations ?? [],
    };
  }

  // Unchanged behavior from the prior /api/capacity-status route. Also
  // where "bottleneck identification" already lives — the milestone's
  // separately-listed capability is this same computation, not a new one.
  async getCapacityStatus(plantId: string) {
    const workloadRes = await internalFetch(`${SCHEDULING_SERVICE_URL}/scheduling/workload?plantId=${encodeURIComponent(plantId)}`, {
      cache: "no-store",
    });
    if (!workloadRes.ok) throw new Error("scheduling-service unavailable");
    const data = (await workloadRes.json()) as { machines: { machineId: string; machineName: string; loadPct: number }[] };
    const machines = data.machines ?? [];
    const bottlenecks = machines.filter((m) => m.loadPct >= BOTTLENECK_THRESHOLD_PCT);
    return { machines, bottlenecks, bottleneck_threshold_pct: BOTTLENECK_THRESHOLD_PCT };
  }

  // Unchanged behavior from the prior /api/simulate-schedule route — real,
  // non-committing. Never touched by the reschedule/AFFECTED work below;
  // no seed order is ever threaded into a what-if call.
  async simulateWhatIf(params: { plantId: string; productionOrderId: string; capacityAdjustments: { workCenterId: string; additionalMachineCount: number }[] }) {
    const { plantId, productionOrderId, capacityAdjustments } = params;

    const whatIfRes = await internalFetch(`${SCHEDULING_SERVICE_URL}/scheduling/what-if`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plantId, scope: "ALL", mode: "FORWARD", capacityAdjustments }),
    });
    if (!whatIfRes.ok) throw new Error("scheduling-service what-if failed");
    const result = await whatIfRes.json();
    const mySimOps = ((result.simulatedOperations ?? []) as { productionOrderId: string; machineId: string; scheduledStart: string; scheduledEnd: string }[])
      .filter((op) => op.productionOrderId === productionOrderId);

    const machineCache = new Map<string, string>();
    const operations = [];
    for (const op of mySimOps) {
      if (!machineCache.has(op.machineId)) {
        if (op.machineId.startsWith("whatif-synthetic-")) {
          machineCache.set(op.machineId, "Hypothetical machine (this what-if)");
        } else {
          const machineRes = await internalFetch(`${MACHINE_SERVICE_URL}/machines/${op.machineId}`);
          const machine = machineRes.ok ? await machineRes.json() : null;
          machineCache.set(op.machineId, machine?.name ?? "Unknown machine");
        }
      }
      operations.push({
        machine_name: machineCache.get(op.machineId),
        scheduled_start: op.scheduledStart,
        scheduled_end: op.scheduledEnd,
      });
    }
    operations.sort((a, b) => (a.scheduled_start > b.scheduled_start ? 1 : -1));

    return {
      simulated_operations: operations,
      conflicts_detected: result.conflictsDetected ?? 0,
      projected_completion: operations.length > 0 ? operations[operations.length - 1].scheduled_end : null,
    };
  }

  // Real, read-only preview — never commits. Backed by scheduling-service's
  // own resolveScopedOrderIds() (via GET /scheduling/affected-orders), so
  // this can never define "affected" differently from the real committing
  // run below. Used both by Ledger's pre-click preview and by the Agent
  // Console's approval-gate preview before a conversational reschedule
  // request is ever approved.
  async resolveAffectedOrders(params: { plantId: string; productionOrderId: string; scope: "SINGLE" | "AFFECTED" }) {
    const { plantId, productionOrderId, scope } = params;
    const url = `${SCHEDULING_SERVICE_URL}/scheduling/affected-orders?plantId=${encodeURIComponent(plantId)}&productionOrderId=${encodeURIComponent(productionOrderId)}&scope=${scope}`;
    const res = await internalFetch(url, { cache: "no-store" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? "scheduling-service affected-orders lookup failed");
    }
    return (await res.json()) as { scope: string; targetOrderId: string; scopedOrderIds: string[] };
  }

  // Real, committing — the one genuinely new capability this milestone
  // adds. Never defaults scope to ALL: the caller (Ledger's Reschedule/
  // Optimize buttons, or the Agent Console reschedule node) always
  // decides SINGLE vs AFFECTED explicitly before calling this — see
  // RescheduleActions.tsx and graph.py's reschedule node for exactly
  // where that decision is made and why.
  async reschedule(params: { plantId: string; productionOrderId: string; scope: "SINGLE" | "AFFECTED"; mode: "FORWARD" | "BACKWARD" | "BOTTLENECK" }) {
    const { plantId, productionOrderId, scope, mode } = params;
    const res = await internalFetch(`${SCHEDULING_SERVICE_URL}/scheduling/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plantId, scope, mode, productionOrderId }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? "scheduling-service run failed");
    }
    return (await res.json()) as {
      runId: string;
      ordersProcessed: number;
      operationsScheduled: number;
      conflictsDetected: number;
      scheduleVersion: number;
      scope: string;
      targetOrderId?: string;
      scopedOrderIds?: string[];
    };
  }
}

export const apsAgent = new APSAgent();
