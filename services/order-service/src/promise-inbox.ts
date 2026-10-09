// Phase 14 (Promise Risk & Decision Inbox) — the one aggregation endpoint
// this phase's brief allows ("if aggregation requires a new endpoint,
// implement it at the appropriate service boundary"). Lives in
// order-service because every domain row it reads (SalesOrder/OrderLine/
// FulfillmentPlan/FulfillmentLine/ProductionOrder/ScheduledOperation/
// ProductionException) is already this service's own tenant-scoped data;
// AgentPipelineRun is read directly too (same Postgres, same @aps/domain
// Prisma client — no new HTTP call to agent-orchestrator needed).
//
// No LLM anywhere in this file. Risk is calculated via @aps/domain's
// classifyPromiseRisk/comparePromisePriority — this module's only job is
// turning real rows into PromiseEvidence and aggregating per SalesOrder.
import {
  prisma,
  classifyPromiseRisk,
  comparePromisePriority,
  type PromiseEvidence,
  type PromiseRiskStatus,
  type PromiseRiskReasonCode,
  type PromiseWorkflowStatus,
} from "@aps/domain";

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
  delayHours: number | null;
  pendingApprovalRunId: string | null;
  // Phase 15 (Promise Intelligence & Evidence Quality) — real evidence
  // freshness: the most recent ScheduledOperation.updatedAt among this
  // leg's current (non-superseded) operations, or null when there's no
  // schedule evidence to date at all. Never the response's own
  // generatedAt (which only says "this read happened now," not "the
  // underlying schedule was touched recently") — this is the field that
  // actually answers "how current is the evidence behind this number."
  scheduleAsOf: string | null;
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

export type PromiseInboxFilters = {
  limit?: number;
  offset?: number;
  search?: string;
  riskStatus?: PromiseRiskStatus[];
  pendingApprovalOnly?: boolean;
};

// Same group/workflow ordering @aps/domain's comparePromisePriority uses
// internally — duplicated here (not imported, since it's not exported
// from that module) only for the hybrid-order "worst line wins"
// aggregation below. Any change to the priority brief's own ordering
// must be mirrored in both places.
const RISK_GROUP_ORDER: Record<PromiseRiskStatus, number> = { BREACHED: 0, AT_RISK: 1, UNKNOWN: 2, SAFE: 3 };
const WORKFLOW_URGENCY_ORDER: Record<PromiseWorkflowStatus, number> = {
  AWAITING_APPROVAL: 0,
  RECOVERY_VERIFIED_FAILED: 1,
  NONE: 2,
  RECOVERY_VERIFIED_RESTORED: 3,
};

function recommendedAction(riskStatus: PromiseRiskStatus, workflowStatus: PromiseWorkflowStatus): string {
  if (workflowStatus === "AWAITING_APPROVAL") return "Review and approve or reject the pending recovery recommendation.";
  if (riskStatus === "BREACHED") return "Investigate the cause and initiate a recovery reschedule.";
  if (riskStatus === "AT_RISK") return "Monitor closely; consider a pre-emptive recovery action.";
  if (riskStatus === "UNKNOWN") return "Investigate missing or stale schedule evidence before relying on this promise.";
  if (workflowStatus === "RECOVERY_VERIFIED_FAILED") return "The last recovery attempt did not restore this promise; re-plan.";
  return "No action needed.";
}

type FulfillmentLineRow = Awaited<ReturnType<typeof queryFulfillmentLines>>[number];

async function queryFulfillmentLines(enterpriseId: string) {
  return prisma.fulfillmentLine.findMany({
    where: {
      promisedDate: { not: null },
      status: { notIn: ["CANCELLED", "FULFILLED"] },
      fulfillmentPlan: { orderLine: { order: { enterpriseId } } },
    },
    include: {
      fulfillmentPlan: { include: { orderLine: { include: { order: { include: { customer: true } } } } } },
      productionOrder: { include: { scheduledOperations: { include: { exceptions: true } } } },
    },
  });
}

type ClassifiedLine = {
  line: FulfillmentLineRow;
  riskStatus: PromiseRiskStatus;
  workflowStatus: PromiseWorkflowStatus;
  explanation: string;
  reasonCode: PromiseRiskReasonCode;
  delayHours: number | null;
  projectedDeliveryDate: Date | null;
  scheduleAsOf: Date | null;
  pendingApprovalRunId: string | null;
};

// Phase 15 — an operation whose own scheduled window has already passed
// but which was never confirmed one way or the other (never started,
// never completed, never flagged BLOCKED) is not reliable evidence of
// anything: using its scheduledEnd as part of "projected delivery" would
// silently assume the shop floor kept pace with the plan, which nothing
// here actually confirms. real actualEnd (not just status) is the
// authoritative "did this really happen" signal — status alone can lag
// behind reality, actualEnd is set only at real completion (see mes-
// integration's /mes/completions).
function isUnconfirmedOverdue(op: { scheduledEnd: Date; actualEnd: Date | null; status: string }, now: Date): boolean {
  return op.scheduledEnd.getTime() < now.getTime() && op.actualEnd === null && (op.status === "PLANNED" || op.status === "SCHEDULED");
}

function classifyLine(
  line: FulfillmentLineRow,
  runsByProductionOrder: Map<string, { id: string; approvalStatus: string | null; executionResult: unknown; executedAt: Date | null; createdAt: Date }[]>,
  now: Date
): ClassifiedLine {
  const po = line.productionOrder;
  const hasProductionLeg = line.sourceType === "PRODUCTION";

  let scheduleEvidence: PromiseEvidence["scheduleEvidence"] = "AVAILABLE";
  let projectedDeliveryDate: Date | null = null;
  let allOperationsDone = false;
  let openExceptionCount = 0;
  let hasOpenQcHold = false;
  let scheduleAsOf: Date | null = null;

  if (hasProductionLeg) {
    if (!po) {
      scheduleEvidence = "MISSING";
    } else {
      // supersededAt excludes rows a later re-schedule replaced — only the
      // CURRENT schedule version counts as real evidence.
      const activeOps = po.scheduledOperations.filter((op) => !op.supersededAt);
      if (activeOps.length === 0) {
        scheduleEvidence = "MISSING";
      } else {
        projectedDeliveryDate = new Date(Math.max(...activeOps.map((op) => op.scheduledEnd.getTime())));
        allOperationsDone = activeOps.every((op) => op.status === "DONE");
        openExceptionCount = activeOps.reduce((sum, op) => sum + op.exceptions.filter((e) => !e.resolvedAt).length, 0);
        hasOpenQcHold = activeOps.some((op) => op.status === "BLOCKED");
        scheduleAsOf = new Date(Math.max(...activeOps.map((op) => op.updatedAt.getTime())));
        // Phase 15 — real staleness, not merely absence: at least one
        // operation's own window has already passed with no confirmation
        // it ever started or finished. The computed projectedDeliveryDate
        // above still assumes it did — that assumption is exactly what
        // "missing data must never be silently treated as zero delay"
        // forbids, so this overrides AVAILABLE before classification sees it.
        if (activeOps.some((op) => isUnconfirmedOverdue(op, now))) {
          scheduleEvidence = "STALE";
        }
      }
    }
  }

  const runsForOrder = po ? runsByProductionOrder.get(po.id) ?? [] : [];
  const pendingRun = runsForOrder.find((r) => r.approvalStatus === "PENDING");
  const lastConsumedRun = runsForOrder.find((r) => r.approvalStatus === "CONSUMED" && r.executionResult);
  const lastVerifiedRecovery = (() => {
    if (!lastConsumedRun) return null;
    const result = lastConsumedRun.executionResult as { goal_satisfaction?: { satisfied?: unknown } } | null;
    if (!result?.goal_satisfaction || typeof result.goal_satisfaction.satisfied !== "boolean") return null;
    return { satisfied: result.goal_satisfaction.satisfied, verifiedAt: lastConsumedRun.executedAt ?? lastConsumedRun.createdAt };
  })();

  const evidence: PromiseEvidence = {
    promisedDate: line.promisedDate!,
    hasProductionLeg,
    productionOrderStatus: po?.status ?? null,
    scheduleEvidence,
    projectedDeliveryDate,
    allOperationsDone,
    openExceptionCount,
    hasOpenQcHold,
    pendingRecoveryApproval: !!pendingRun,
    lastVerifiedRecovery,
    now,
  };
  const result = classifyPromiseRisk(evidence);

  return {
    line,
    riskStatus: result.riskStatus,
    workflowStatus: result.workflowStatus,
    explanation: result.explanation,
    reasonCode: result.reasonCode,
    delayHours: result.delayHours,
    projectedDeliveryDate,
    scheduleAsOf,
    pendingApprovalRunId: pendingRun?.id ?? null,
  };
}

// Picks the single "worst" line to represent a SalesOrder with multiple
// FulfillmentLines (the HYBRID case: one STOCK leg + one PRODUCTION leg
// for the same OrderLine, or a multi-OrderLine order with several
// independently-tracked promises) — never averaged, never silently
// dropped. Same group/workflow ordering as @aps/domain's own
// comparePromisePriority, applied here across lines instead of orders.
function pickWorstLine(group: ClassifiedLine[]): ClassifiedLine {
  let worst = group[0];
  for (const cl of group.slice(1)) {
    const riskDiff = RISK_GROUP_ORDER[cl.riskStatus] - RISK_GROUP_ORDER[worst.riskStatus];
    if (riskDiff < 0) {
      worst = cl;
      continue;
    }
    if (riskDiff > 0) continue;
    const workflowDiff = WORKFLOW_URGENCY_ORDER[cl.workflowStatus] - WORKFLOW_URGENCY_ORDER[worst.workflowStatus];
    if (workflowDiff < 0) {
      worst = cl;
      continue;
    }
    if (workflowDiff > 0) continue;
    if ((cl.delayHours ?? 0) > (worst.delayHours ?? 0)) worst = cl;
  }
  return worst;
}

function buildSummary(items: PromiseInboxItem[]): PromiseInboxSummary {
  const summary: PromiseInboxSummary = {
    breached: 0,
    atRisk: 0,
    unknown: 0,
    safe: 0,
    awaitingApproval: 0,
    restoredAfterRecovery: 0,
    recoveryFailed: 0,
  };
  for (const item of items) {
    if (item.riskStatus === "BREACHED") summary.breached++;
    else if (item.riskStatus === "AT_RISK") summary.atRisk++;
    else if (item.riskStatus === "UNKNOWN") summary.unknown++;
    else summary.safe++;

    if (item.workflowStatus === "AWAITING_APPROVAL") summary.awaitingApproval++;
    else if (item.workflowStatus === "RECOVERY_VERIFIED_RESTORED") summary.restoredAfterRecovery++;
    else if (item.workflowStatus === "RECOVERY_VERIFIED_FAILED") summary.recoveryFailed++;
  }
  return summary;
}

// This is a read-only aggregation: no write, no approval claim, no
// execution — opening/filtering/refreshing the inbox can never trigger a
// consequential action (brief §6), which this function structurally
// guarantees simply by never calling any mutating Prisma method or
// approval handler.
export async function getPromiseInbox(enterpriseId: string, filters: PromiseInboxFilters = {}): Promise<PromiseInboxResponse> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);
  const now = new Date();

  const lines = await queryFulfillmentLines(enterpriseId);

  const productionOrderIds = [...new Set(lines.map((l) => l.productionOrderId).filter((id): id is string => !!id))];

  // ONE bulk AgentPipelineRun query for the whole enterprise's recovery
  // workflow state — never queried per-order (N+1 avoidance, brief §7).
  const runs =
    productionOrderIds.length > 0
      ? await prisma.agentPipelineRun.findMany({
          where: { enterpriseId, approvalAction: "RESCHEDULE_PRODUCTION" },
          select: { id: true, approvalStatus: true, approvalPayload: true, executionResult: true, executedAt: true, createdAt: true },
          orderBy: { createdAt: "desc" },
        })
      : [];

  const runsByProductionOrder = new Map<string, typeof runs>();
  for (const run of runs) {
    const payload = run.approvalPayload as { production_order_id?: string } | null;
    const poId = payload?.production_order_id;
    if (!poId) continue;
    const bucket = runsByProductionOrder.get(poId);
    if (bucket) bucket.push(run);
    else runsByProductionOrder.set(poId, [run]);
  }

  const classifiedLines = lines.map((line) => classifyLine(line, runsByProductionOrder, now));

  // Group by SalesOrder — one promise-risk row per order, not per line.
  const bySalesOrder = new Map<string, ClassifiedLine[]>();
  for (const cl of classifiedLines) {
    const salesOrderId = cl.line.fulfillmentPlan.orderLine.order.id;
    const bucket = bySalesOrder.get(salesOrderId);
    if (bucket) bucket.push(cl);
    else bySalesOrder.set(salesOrderId, [cl]);
  }

  // Request-scoped — the real, pre-existing SalesOrder.priority for each
  // order in this result, read off the relation already fetched above
  // (no second query, no invented weight).
  const orderPriorityById = new Map<string, number>();

  const allItems: PromiseInboxItem[] = [];
  for (const group of bySalesOrder.values()) {
    const order = group[0].line.fulfillmentPlan.orderLine.order;
    orderPriorityById.set(order.id, order.priority);
    const worst = pickWorstLine(group);

    // Dedupe by OrderLine (not FulfillmentLine) — a HYBRID line's STOCK +
    // PRODUCTION legs share one OrderLine/productName and must not be
    // double-counted in the product summary.
    const productsByOrderLine = new Map<string, { productName: string; quantity: number }>();
    for (const cl of group) {
      const ol = cl.line.fulfillmentPlan.orderLine;
      productsByOrderLine.set(ol.id, { productName: ol.productName, quantity: ol.quantity });
    }

    allItems.push({
      salesOrderId: order.id,
      orderNumber: order.orderNumber ?? null,
      externalOrderId: order.externalOrderId ?? null,
      customerId: order.customerId,
      customerName: order.customer.name,
      productSummary: [...productsByOrderLine.values()].map((p) => `${p.productName} x${p.quantity}`).join(", "),
      promisedDate: worst.line.promisedDate!.toISOString(),
      projectedDeliveryDate: worst.projectedDeliveryDate ? worst.projectedDeliveryDate.toISOString() : null,
      delayHours: worst.delayHours,
      riskStatus: worst.riskStatus,
      workflowStatus: worst.workflowStatus,
      explanation: worst.explanation,
      reasonCode: worst.reasonCode,
      scheduleAsOf: worst.scheduleAsOf ? worst.scheduleAsOf.toISOString() : null,
      recommendedAction: recommendedAction(worst.riskStatus, worst.workflowStatus),
      productionOrderId: worst.line.productionOrderId,
      pendingApprovalRunId: worst.pendingApprovalRunId,
      lines: group.map((cl) => ({
        fulfillmentLineId: cl.line.id,
        sourceType: cl.line.sourceType,
        quantity: cl.line.quantity,
        productionOrderId: cl.line.productionOrderId,
        promisedDate: cl.line.promisedDate!.toISOString(),
        projectedDeliveryDate: cl.projectedDeliveryDate ? cl.projectedDeliveryDate.toISOString() : null,
        riskStatus: cl.riskStatus,
        workflowStatus: cl.workflowStatus,
        explanation: cl.explanation,
        reasonCode: cl.reasonCode,
        scheduleAsOf: cl.scheduleAsOf ? cl.scheduleAsOf.toISOString() : null,
        delayHours: cl.delayHours,
        pendingApprovalRunId: cl.pendingApprovalRunId,
      })),
    });
  }

  // Deterministic prioritization (brief §5) — priorityScore is the
  // SalesOrder's own real, pre-existing `priority` field; nothing invented.
  allItems.sort((a, b) =>
    comparePromisePriority(
      {
        riskStatus: a.riskStatus,
        workflowStatus: a.workflowStatus,
        delayHours: a.delayHours,
        promisedDate: new Date(a.promisedDate),
        priorityScore: orderPriorityById.get(a.salesOrderId) ?? null,
      },
      {
        riskStatus: b.riskStatus,
        workflowStatus: b.workflowStatus,
        delayHours: b.delayHours,
        promisedDate: new Date(b.promisedDate),
        priorityScore: orderPriorityById.get(b.salesOrderId) ?? null,
      }
    )
  );

  // Summary is computed from the FULL, unfiltered-by-search/risk/approval
  // population — a planner narrowing the table with a search box or a
  // filter must never see the top summary counts change along with it.
  const summary = buildSummary(allItems);

  let filtered = allItems;
  if (filters.riskStatus && filters.riskStatus.length > 0) {
    const allowed = new Set(filters.riskStatus);
    filtered = filtered.filter((item) => allowed.has(item.riskStatus));
  }
  if (filters.pendingApprovalOnly) {
    filtered = filtered.filter((item) => item.workflowStatus === "AWAITING_APPROVAL");
  }
  if (filters.search) {
    const q = filters.search.toLowerCase();
    filtered = filtered.filter(
      (item) =>
        (item.orderNumber ?? "").toLowerCase().includes(q) ||
        (item.externalOrderId ?? "").toLowerCase().includes(q) ||
        item.customerName.toLowerCase().includes(q)
    );
  }

  const total = filtered.length;
  const items = filtered.slice(offset, offset + limit);

  return { items, total, limit, offset, summary, generatedAt: now.toISOString() };
}
