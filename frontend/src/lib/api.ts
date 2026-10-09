import type { FinancialAdjustment } from "@/types/approvals";
import type { AuditEvent } from "@/types/audit";
import type {
  Consignment,
  ExportOrder,
  Invoice,
  PostSalesAction,
  Project,
  ProjectMilestone,
  SalesOrder,
  ServiceOrder,
  TradingOrder,
} from "@/types/channels";
import type { GoalSatisfaction, SalesOrderApprovalResult, WorkflowResult } from "@/types/workflow";
import type { ActiveWorkflowItem } from "@/types/workflows";

// Auth/Authz hardening, Phase 1 (Finding 1.2): this used to point directly
// at agent-orchestrator's own URL (NEXT_PUBLIC_API_BASE_URL, baked into the
// client bundle) — the browser called the backend directly, bypassing
// Ledger's own server (and any auth on it) entirely. Now routes through
// Ledger's own same-origin proxy (see app/api/orchestrator/[...path]/
// route.ts), which is what actually holds the session and forwards a
// verified identity to agent-orchestrator — this file no longer needs to
// know the orchestrator's real network address at all.
const API_BASE_URL = "/api/orchestrator";

// Real gap found live (agreed with the user): a tracked order whose
// backend data genuinely no longer exists (e.g. after a demo-data reset)
// used to sit in the panel erroring forever, every 4s, with no way to
// tell "this is really gone" apart from any other transient failure.
// Carries the real HTTP status so a caller can distinguish a confirmed
// 404 (safe to stop tracking) from a flaky/down backend (should keep
// retrying, not silently drop something still real).
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// Real bug found live: API_BASE_URL is a relative path ("/api/orchestrator"),
// which only resolves inside a browser fetch (against window.location) — a
// Server Component (e.g. production-planning/page.tsx, which calls this
// module directly during server-side rendering) runs on Node, where fetch
// requires an absolute URL, and throws "Failed to parse URL" instead.
// Rather than self-fetching Ledger's own proxy route (which would also need
// its incoming cookies forwarded by hand just to pass the route's own
// auth() check), a server-side call authenticates and calls
// agent-orchestrator directly, in-process — the exact same real signed-in
// identity + internal-service-token the proxy route itself forwards (see
// app/api/orchestrator/[...path]/route.ts), just without the extra HTTP hop.
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const isServer = typeof window === "undefined";
  let url: string;
  let headers: Record<string, string> = { "Content-Type": "application/json" };

  if (isServer) {
    const { auth } = await import("@/lib/auth");
    const session = await auth();
    if (!session?.user) throw new ApiError("Authentication required", 401);
    const token = process.env.INTERNAL_SERVICE_TOKEN;
    if (!token) throw new ApiError("Service misconfigured — internal auth token not set", 500);
    const orchestratorUrl = process.env.AGENT_ORCHESTRATOR_URL ?? "http://localhost:8000";
    url = `${orchestratorUrl}${path}`;
    headers = {
      ...headers,
      "x-internal-token": token,
      "x-forwarded-user": session.user.id,
      "x-forwarded-role": session.user.role,
    };
  } else {
    url = `${API_BASE_URL}${path}`;
  }

  const res = await fetch(url, {
    headers,
    ...init,
  });

  if (!res.ok) {
    const text = await res.text();
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed?.detail === "string") detail = parsed.detail;
    } catch {
      // not JSON — fall back to the raw text
    }
    throw new ApiError(detail, res.status);
  }

  // Real bug found live: res.json() had no guard — a transient hiccup
  // (a backend mid-restart, a proxy timeout) can return a 200-with-empty-
  // or-non-JSON body, and an unguarded JSON.parse surfaces as a raw
  // "Unexpected token ... in JSON" SyntaxError instead of a clean,
  // catchable ApiError every caller already knows how to handle (see
  // TrackOrderPanel's own poll() try/catch).
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError("Received an invalid response from the server — try again in a moment.", res.status);
  }
}

export async function runWorkflow(message: string): Promise<WorkflowResult> {
  return request("/pipeline/runs", { method: "POST", body: JSON.stringify({ message }) });
}

// Approval State hardening (agreed with the user): this used to send the
// whole proposal `context` back to the server, trusted verbatim — the
// real gap the original audit found (replayable, tamperable, no durable
// record). Now sends only `runId` — the server looks up its own stored
// payload from when the gate was first reached and executes against
// that. `quantityOverride` is the one real exception: Agent Console's
// approval card already lets a human edit the proposed quantity before
// approving — a legitimate, narrow, explicit part of the decision itself,
// not a full-payload override.
export async function resolveSalesOrderApproval(
  runId: string,
  decision: "APPROVED" | "REJECTED",
  quantityOverride: number | null = null,
  preferVendor = false
): Promise<SalesOrderApprovalResult> {
  return request("/approvals/sales-order/resolve", {
    method: "POST",
    body: JSON.stringify({ run_id: runId, decision, quantity_override: quantityOverride, prefer_vendor: preferVendor }),
  });
}

// The conversational counterpart to rescheduleSalesOrder below — both
// converge on the same backend mfg.reschedule_production_order() call
// (see approvals.py's own comment), so there is one authoritative
// implementation of APS rescheduling regardless of which entry point
// (Ledger button or Agent Console chat) triggered it. `context` is
// echoed back verbatim from the pending_approval this run already
// produced — nothing is re-derived client-side.
export type RescheduleApprovalResult = {
  resolved: boolean;
  status: string;
  sales_order_id?: string;
  kind?: "reschedule" | "optimize";
  runId?: string;
  ordersProcessed?: number;
  operationsScheduled?: number;
  conflictsDetected?: number;
  scheduleVersion?: number;
  scope?: string;
  targetOrderId?: string;
  scopedOrderIds?: string[];
  // Phase 11 — only present for a PROMISE_RECOVERY-originated reschedule
  // (see approvals.py's _evaluate_reschedule_goal_satisfaction); null for
  // the plain chat/Ledger-button reschedule path, which has no promise to
  // verify against.
  goal_satisfaction?: GoalSatisfaction | null;
};
// Same reasoning as resolveSalesOrderApproval above — runId only, no
// client-supplied context. Reschedule has no analogous edit-before-
// approving feature, so nothing else is needed here.
export function resolveRescheduleApproval(runId: string, decision: "APPROVED" | "REJECTED") {
  return request<RescheduleApprovalResult>("/approvals/reschedule/resolve", {
    method: "POST",
    body: JSON.stringify({ run_id: runId, decision }),
  });
}

export async function listFinancialApprovals(): Promise<FinancialAdjustment[]> {
  const data = await request<{ items: FinancialAdjustment[] }>("/approvals/financial");
  return data.items;
}

export async function resolveFinancialApproval(
  id: string,
  decision: "APPROVED" | "REJECTED",
  resolvedBy: string
): Promise<FinancialAdjustment> {
  return request(`/approvals/financial/${id}/resolve`, {
    method: "POST",
    body: JSON.stringify({ decision, resolved_by: resolvedBy }),
  });
}

export async function postFinancialApproval(id: string): Promise<FinancialAdjustment> {
  return request(`/approvals/financial/${id}/post`, { method: "POST" });
}

export async function listRecentAuditEvents(limit = 100): Promise<AuditEvent[]> {
  const data = await request<{ items: AuditEvent[] }>(`/audit/events?limit=${limit}`);
  return data.items;
}

export async function listActiveWorkflows(): Promise<ActiveWorkflowItem[]> {
  const data = await request<{ items: ActiveWorkflowItem[] }>("/workflows/active");
  return data.items;
}

async function listChannel<T>(path: string): Promise<T[]> {
  const data = await request<{ items: T[] }>(path);
  return data.items;
}

export const listDomesticSalesOrders = () => listChannel<SalesOrder>("/channels/domestic-sales");
export const listExportSalesOrders = () => listChannel<ExportOrder>("/channels/export-sales");
export const listServicesSalesOrders = () => listChannel<ServiceOrder>("/channels/services-sales");
export const listReturns = () => listChannel<PostSalesAction>("/channels/returns");
export const listConsignmentSales = () => listChannel<Consignment>("/channels/consignment-sales");
export const listProjectSales = () => listChannel<Project>("/channels/project-sales");
export const listTradingOrders = () => listChannel<TradingOrder>("/channels/trading");
export const listProjectMilestones = (projectId: string) =>
  listChannel<ProjectMilestone>(`/channels/project-sales/${projectId}/milestones`);
export const listInvoices = () => listChannel<Invoice>("/channels/billing");
export const markInvoicePaid = (invoiceId: string) =>
  request<{ updated: boolean; invoice_id: string; status: string }>(`/channels/billing/${invoiceId}/mark-paid`, {
    method: "POST",
  });

export type MasterCustomer = { customer_id: string; customer_name: string; active: boolean; credit_limit: number };
export type MasterProduct = { product_id: string; product_name: string; price: number };
export const listMasterCustomers = () => listChannel<MasterCustomer>("/masterdata/customers");
export const listMasterProducts = () => listChannel<MasterProduct>("/masterdata/products");

// Plan History (Production Planning page) — reads AgentPipelineRun/
// AgentStageResult, written by every /pipeline/runs call. Best-effort on
// the backend itself (returns an empty list rather than erroring if
// DATABASE_URL isn't reachable), so no extra error handling needed here.
export type PipelineRunSummary = {
  id: string;
  status: string;
  currentStage: string | null;
  createdAt: string;
  finishedAt: string | null;
};
export type PipelineRunDetail = PipelineRunSummary & {
  stages: { id: string; stage: string; agentOutput: Record<string, unknown>; createdAt: string }[];
};
export const listPipelineRuns = () => listChannel<PipelineRunSummary>("/pipeline/runs");
export const getPipelineRun = (runId: string) => request<PipelineRunDetail | null>(`/pipeline/runs/${runId}`);

// "Pending decisions" panel (Agent Console) — runs left sitting at the
// approval gate, recoverable after "New session" or a navigation wiped
// them from the browser. `pending_approval` mirrors WorkflowResult's own
// field exactly, since it's read straight off the same composed_execution
// stage output that would have produced it live.
export type PendingApprovalEntry = {
  run_id: string;
  created_at: string;
  pending_approval: WorkflowResult["pending_approval"];
  response?: string;
};
export const listPendingApprovals = () => listChannel<PendingApprovalEntry>("/pipeline/pending");

// Phase 2 (agreed with the user) — the What-if bridge on the Sales Order
// detail page. Real, non-committing: nothing is written by this call.
export type SimulatedOperation = { machine_name: string; scheduled_start: string; scheduled_end: string };
export type SimulationResult = {
  simulated_operations: SimulatedOperation[];
  conflicts_detected: number;
  projected_completion: string | null;
};
export function simulateSalesOrderSchedule(salesOrderId: string, workCenterId: string, additionalMachineCount: number) {
  return request<SimulationResult>(`/sales-orders/${encodeURIComponent(salesOrderId)}/simulate`, {
    method: "POST",
    body: JSON.stringify({ work_center_id: workCenterId, additional_machine_count: additionalMachineCount }),
  });
}

// Real, committing — buildable now that scheduling-service's SINGLE/
// AFFECTED scope genuinely narrows to real orders (see pipeline.ts's
// resolveScopedOrderIds). Two named actions, not a raw scope passthrough:
// "reschedule" = scope SINGLE (only this order); "optimize" = scope
// AFFECTED (this order + any other real order sharing its work centers).
// Never a plant-wide action — the backend rejects anything else.
export type RescheduleKind = "reschedule" | "optimize";
export type RescheduleResult = {
  runId: string;
  ordersProcessed: number;
  operationsScheduled: number;
  conflictsDetected: number;
  scheduleVersion: number;
  scope: "SINGLE" | "AFFECTED";
  targetOrderId?: string;
  scopedOrderIds?: string[];
};
export function rescheduleSalesOrder(salesOrderId: string, kind: RescheduleKind) {
  return request<RescheduleResult>(`/sales-orders/${encodeURIComponent(salesOrderId)}/reschedule`, {
    method: "POST",
    body: JSON.stringify({ kind }),
  });
}

// Real, read-only preview — never commits. Shows the real target +
// affected order ids before Reschedule/Optimize is clicked, using the
// exact same resolution the committing call above uses.
export type ReschedulePreview = { scope: string; targetOrderId: string; scopedOrderIds: string[] };
export function previewSalesOrderReschedule(salesOrderId: string, kind: RescheduleKind) {
  return request<ReschedulePreview>(`/sales-orders/${encodeURIComponent(salesOrderId)}/reschedule-preview?kind=${kind}`);
}

// Track Order panel (Agent Console, post-approval) — polled every few
// seconds. Real gap this closes: the approval screen used to show the
// plan at the moment you approved it and never look again, so anything
// that happened afterward (Start/Complete on Execution, the order-to-cash
// loop firing) was invisible unless you went and hunted for it on a
// different page.
export type OrderTrackingOperation = {
  operation: string;
  machine: string | null;
  operator: string | null;
  status: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
};
export type OrderTracking = {
  production_order_id: string;
  stage: string;
  operations: OrderTrackingOperation[];
  delivery: { delivery_id: string; status: string; confirmed_delivery_date: string | null } | null;
  invoice: { invoice_id: string; status: string; invoice_amount: number } | null;
};
export const getOrderTracking = (productionOrderId: string, salesOrderId: string | null) =>
  request<OrderTracking>(
    `/production-orders/${productionOrderId}/tracking${salesOrderId ? `?sales_order_id=${encodeURIComponent(salesOrderId)}` : ""}`
  );

// Phase 14 (Promise Risk & Decision Inbox) — thin passthrough chain:
// this call -> Ledger's own /api/orchestrator proxy -> agent-orchestrator's
// GET /sales-orders/promises -> order-service's real aggregation endpoint
// (src/promise-inbox.ts), which classifies every active promise via
// @aps/domain's classifyPromiseRisk. No reasoning happens in any of these
// hops — riskStatus/workflowStatus/explanation are already fully computed
// by the time this type sees them. Fetched once with a generous limit;
// search/sort/filter happen client-side on the already-fetched set (same
// convention as every other channel page in this app — none of them
// filter server-side either), so `summary` always reflects the true,
// unfiltered population, never the narrowed table.
export type PromiseRiskStatus = "BREACHED" | "AT_RISK" | "SAFE" | "UNKNOWN";
export type PromiseWorkflowStatus = "NONE" | "AWAITING_APPROVAL" | "RECOVERY_VERIFIED_RESTORED" | "RECOVERY_VERIFIED_FAILED";

// Phase 15 (Promise Intelligence & Evidence Quality) — a short, stable
// code alongside `explanation`, one per classification branch in
// @aps/domain's classifyPromiseRisk. Kept as a plain string here (not a
// union) since this app doesn't depend on @aps/domain directly and a
// union would need to be hand-kept in sync; the backend is the single
// source of truth for which codes exist.
export type PromiseRiskReasonCode = string;

export type PromiseInboxLine = {
  fulfillmentLineId: string;
  sourceType: string;
  quantity: number;
  productionOrderId: string | null;
  promisedDate: string;
  projectedDeliveryDate: string | null;
  riskStatus: PromiseRiskStatus;
  workflowStatus: PromiseWorkflowStatus;
  explanation: string;
  reasonCode: PromiseRiskReasonCode;
  scheduleAsOf: string | null;
  delayHours: number | null;
  pendingApprovalRunId: string | null;
};

export type PromiseInboxItem = {
  salesOrderId: string;
  orderNumber: string | null;
  externalOrderId: string | null;
  customerId: string;
  customerName: string;
  productSummary: string;
  promisedDate: string;
  projectedDeliveryDate: string | null;
  delayHours: number | null;
  riskStatus: PromiseRiskStatus;
  workflowStatus: PromiseWorkflowStatus;
  explanation: string;
  reasonCode: PromiseRiskReasonCode;
  scheduleAsOf: string | null;
  recommendedAction: string;
  productionOrderId: string | null;
  pendingApprovalRunId: string | null;
  lines: PromiseInboxLine[];
};

export type PromiseInboxSummary = {
  breached: number;
  atRisk: number;
  unknown: number;
  safe: number;
  awaitingApproval: number;
  restoredAfterRecovery: number;
  recoveryFailed: number;
};

export type PromiseInboxResponse = {
  items: PromiseInboxItem[];
  total: number;
  limit: number;
  offset: number;
  summary: PromiseInboxSummary;
  generatedAt: string;
};

export const listPromiseInbox = () => request<PromiseInboxResponse>("/sales-orders/promises?limit=200");
