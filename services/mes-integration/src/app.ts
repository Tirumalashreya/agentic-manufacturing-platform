process.env.SERVICE_NAME = "mes-integration";

import { createApp, registerErrorHandler, logger, internalServiceHeaders } from "@aps/shared";
import { signIdentityAssertion } from "@aps/shared/identity";
import { prisma } from "@aps/domain";

// Split out of index.ts (same pattern as inventory-service/order-service's
// own Stage 01 split) so vitest+supertest can exercise this app without
// binding the real port or starting the real Kafka consumer below (moved
// to index.ts). mes-integration had zero tests before this work — this is
// what makes any of them possible.
export const app = createApp();

const ANALYTICS_SERVICE_URL = process.env.ANALYTICS_SERVICE_URL ?? "http://localhost:4017";
const INVENTORY_SERVICE_URL = process.env.INVENTORY_SERVICE_URL ?? "http://localhost:4010";
const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL ?? "http://localhost:4001";
const AGENT_ORCHESTRATOR_URL = process.env.AGENT_ORCHESTRATOR_URL ?? "http://localhost:8000";

// A stale IN_PROGRESS claim (worker crashed mid-step) becomes reclaimable
// once this elapses, rather than blocking recovery forever. Also used by
// the completion-failures listing to decide what counts as "stuck."
const LEASE_WINDOW_MINUTES = 5;

function internalFetchAsEnterprise(enterpriseId: string, input: string, init: RequestInit = {}): Promise<Response> {
  const identityHeader = {
    "x-identity-assertion": signIdentityAssertion(
      { sub: "mes-integration", type: "service" as const, enterpriseId, aud: "aps-internal" },
      process.env.INTERNAL_SERVICE_TOKEN ?? ""
    ),
  };
  return fetch(input, { ...init, headers: { ...init.headers, ...internalServiceHeaders(), ...identityHeader } });
}

// ---------------------------------------------------------------------
// Durable per-step completion orchestration (scrap-aware completion work)
//
// A ProductionOrder's completion side-effects (raw-material issue,
// finished-goods receipt, fulfillment-line update, billing) used to fire
// unconditionally and unrecoverably on `remainingOps === 0` — a second
// completion signal for the same order re-ran everything (duplicate
// movements/invoices), and a mid-sequence failure was only ever logged,
// never retried. This section makes the ProductionOrder status transition
// the single atomic gate, and tracks each downstream effect as a durable
// ProductionCompletionStep row so a crash or failure between steps can be
// recovered from later instead of silently lost.
// ---------------------------------------------------------------------

type ClaimedOrder = {
  id: string;
  enterpriseId: string;
  plantId: string;
  productId: string;
  bomId: string | null;
  quantity: number;
  salesOrderId: string | null;
  metadata: unknown;
  actualGoodUnits: number | null;
  actualTotalUnits: number | null;
};

// The atomic gate: only the caller whose UPDATE actually flips the status
// gets a row back. Every other concurrent/duplicate completion signal for
// the same order gets zero rows and does nothing further — this is what
// makes "two completion requests for the same operation" produce exactly
// one set of downstream effects, not a race between two full attempts.
async function claimProductionOrderCompletion(
  productionOrderId: string,
  actualGoodUnits: number,
  actualTotalUnits: number
): Promise<ClaimedOrder | null> {
  const rows = await prisma.$queryRaw<ClaimedOrder[]>`
    UPDATE "ProductionOrder"
    SET status = 'COMPLETED', "actualGoodUnits" = ${actualGoodUnits}, "actualTotalUnits" = ${actualTotalUnits}, "updatedAt" = now()
    WHERE id = ${productionOrderId} AND status != 'COMPLETED'
    RETURNING id, "enterpriseId", "plantId", "productId", "bomId", quantity, "salesOrderId", metadata, "actualGoodUnits", "actualTotalUnits"
  `;
  return rows[0] ?? null;
}

type PlannedStep = { stepType: "GOODS_ISSUE" | "GOODS_RECEIPT" | "FULFILLMENT_UPDATE" | "BILLING"; stepKey: string };

// Determined once, right after the CAS wins — a real plant code (location)
// is required for the two inventory steps, same precondition the original
// backflush code already had; FULFILLMENT_UPDATE/BILLING never depended
// on it and still don't.
async function planCompletionSteps(order: ClaimedOrder): Promise<PlannedStep[]> {
  const steps: PlannedStep[] = [];

  const plant = await prisma.plant.findUnique({ where: { id: order.plantId }, select: { code: true } });
  if (plant?.code) {
    const bom = order.bomId
      ? await prisma.bOM.findUnique({ where: { id: order.bomId }, include: { lines: true } })
      : await prisma.bOM.findFirst({ where: { productId: order.productId }, include: { lines: true } });
    if (bom) {
      for (const line of bom.lines) {
        // Keyed by the specific BOM line, not componentId — two lines can
        // legitimately share a component (consumed at two routing steps),
        // and each must get its own independent step/idempotency key.
        steps.push({ stepType: "GOODS_ISSUE", stepKey: line.id });
      }
      steps.push({ stepType: "GOODS_RECEIPT", stepKey: order.productId });
    }
  }

  const metadata = (order.metadata ?? {}) as { fulfillmentLineId?: string };
  if (metadata.fulfillmentLineId) {
    steps.push({ stepType: "FULFILLMENT_UPDATE", stepKey: metadata.fulfillmentLineId });
  }
  if (order.salesOrderId) {
    steps.push({ stepType: "BILLING", stepKey: "billing" });
  }

  return steps;
}

async function claimStep(stepId: string): Promise<boolean> {
  // The lease cutoff is computed in JS and passed as a plain timestamp
  // parameter, rather than built as `now() - (N * interval '1 minute')`
  // inside the query — parameterizing a numeric multiplier against an
  // interval literal is exactly the kind of raw-SQL construction that's
  // easy to get subtly wrong (caught live: an earlier version of this
  // query reclaimed even a *fresh* IN_PROGRESS claim). A plain `<
  // $cutoff` comparison has no such ambiguity.
  const leaseCutoff = new Date(Date.now() - LEASE_WINDOW_MINUTES * 60_000);
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "ProductionCompletionStep"
    SET status = 'IN_PROGRESS', attempts = attempts + 1, "claimedAt" = now(), "updatedAt" = now()
    WHERE id = ${stepId}
      AND (status IN ('PENDING', 'FAILED') OR (status = 'IN_PROGRESS' AND "claimedAt" < ${leaseCutoff}))
    RETURNING id
  `;
  return rows.length > 0;
}

async function succeedStep(stepId: string, resultRef: string | null): Promise<void> {
  await prisma.productionCompletionStep.update({ where: { id: stepId }, data: { status: "SUCCEEDED", resultRef, lastError: null } });
}

async function failStep(stepId: string, error: string): Promise<void> {
  await prisma.productionCompletionStep.update({ where: { id: stepId }, data: { status: "FAILED", lastError: error } });
}

async function executeGoodsIssue(order: ClaimedOrder, stepKey: string): Promise<string> {
  const line = await prisma.bOMLine.findUnique({ where: { id: stepKey } });
  if (!line) throw new Error(`BOMLine ${stepKey} no longer exists`);
  const plant = await prisma.plant.findUnique({ where: { id: order.plantId }, select: { code: true } });
  const location = plant!.code;
  const requiredQty = line.quantityPer * (order.actualTotalUnits ?? order.quantity);

  const response = await internalFetchAsEnterprise(order.enterpriseId, `${INVENTORY_SERVICE_URL}/inventory/goods-issue`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": `${order.id}:GOODS_ISSUE:${stepKey}` },
    body: JSON.stringify({ productId: line.componentId, location, quantity: requiredQty, productionOrderId: order.id }),
  });
  if (!response.ok) throw new Error(`inventory-service goods-issue returned ${response.status}`);
  const movement = (await response.json()) as { id: string };
  return movement.id;
}

async function executeGoodsReceipt(order: ClaimedOrder): Promise<string> {
  const plant = await prisma.plant.findUnique({ where: { id: order.plantId }, select: { code: true } });
  const location = plant!.code;
  const response = await internalFetchAsEnterprise(order.enterpriseId, `${INVENTORY_SERVICE_URL}/inventory/goods-receipt`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": `${order.id}:GOODS_RECEIPT:${order.productId}` },
    body: JSON.stringify({ productId: order.productId, location, quantity: order.actualGoodUnits, productionOrderId: order.id }),
  });
  if (!response.ok) throw new Error(`inventory-service goods-receipt returned ${response.status}`);
  const movement = (await response.json()) as { id: string };
  return movement.id;
}

async function executeFulfillmentUpdate(order: ClaimedOrder, fulfillmentLineId: string): Promise<string> {
  const fulfilled = order.actualGoodUnits ?? 0;
  const line = await prisma.fulfillmentLine.findUnique({ where: { id: fulfillmentLineId }, select: { quantity: true } });
  const shortfallReason =
    line && fulfilled < line.quantity
      ? `${fulfilled} of ${line.quantity} ordered units produced (${(line.quantity - fulfilled).toFixed(0)} short)`
      : undefined;

  const response = await internalFetchAsEnterprise(order.enterpriseId, `${ORDER_SERVICE_URL}/fulfillment-lines/${fulfillmentLineId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fulfilledQuantity: fulfilled, ...(shortfallReason ? { shortfallReason } : {}) }),
  });
  if (!response.ok) throw new Error(`order-service PATCH fulfillment-line returned ${response.status}`);
  return fulfillmentLineId;
}

async function executeBilling(order: ClaimedOrder): Promise<string> {
  const response = await fetch(`${AGENT_ORCHESTRATOR_URL}/production-orders/${order.id}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": `${order.id}:BILLING:billing`, ...internalServiceHeaders() },
    body: JSON.stringify({ actualGoodUnits: order.actualGoodUnits }),
  });
  if (!response.ok) throw new Error(`agent-orchestrator /complete returned ${response.status}`);
  const result = (await response.json()) as { invoice_id?: string | null };
  return result.invoice_id ?? "no-invoice";
}

async function runStep(order: ClaimedOrder, step: { id: string; stepType: string; stepKey: string }): Promise<void> {
  const won = await claimStep(step.id);
  if (!won) return; // another worker already has (or just finished) this step

  try {
    let resultRef: string;
    switch (step.stepType) {
      case "GOODS_ISSUE":
        resultRef = await executeGoodsIssue(order, step.stepKey);
        break;
      case "GOODS_RECEIPT":
        resultRef = await executeGoodsReceipt(order);
        break;
      case "FULFILLMENT_UPDATE":
        resultRef = await executeFulfillmentUpdate(order, step.stepKey);
        break;
      case "BILLING":
        resultRef = await executeBilling(order);
        break;
      default:
        throw new Error(`Unknown step type ${step.stepType}`);
    }
    await succeedStep(step.id, resultRef);
  } catch (error) {
    await failStep(step.id, String(error));
    logger.error("Production completion step failed", { productionOrderId: order.id, stepType: step.stepType, stepKey: step.stepKey, error: String(error) });
  }
}

// Dependency order: raw materials must be recorded consumed before
// finished goods are received (otherwise stock is created from nothing);
// the fulfillment line shouldn't claim a quantity was fulfilled before
// that quantity is confirmed received; billing shouldn't fire before the
// fulfillment record reflects what's actually being billed. Each tier
// only proceeds if every step in the tier(s) before it succeeded —
// skipped steps stay PENDING (never attempted, not a false FAILED signal)
// so a later retry can still pick them up once their prerequisite clears.
async function attemptCompletionSteps(productionOrderId: string): Promise<void> {
  const order = await prisma.productionOrder.findUnique({ where: { id: productionOrderId } });
  if (!order) return;
  const claimedOrder: ClaimedOrder = {
    id: order.id,
    enterpriseId: order.enterpriseId,
    plantId: order.plantId,
    productId: order.productId,
    bomId: order.bomId,
    quantity: order.quantity,
    salesOrderId: order.salesOrderId,
    metadata: order.metadata,
    actualGoodUnits: order.actualGoodUnits,
    actualTotalUnits: order.actualTotalUnits,
  };

  const allSteps = await prisma.productionCompletionStep.findMany({ where: { productionOrderId }, orderBy: { createdAt: "asc" } });
  const byType = (t: string) => allSteps.filter((s) => s.stepType === t);
  const allSucceeded = (rows: typeof allSteps) => rows.every((s) => s.status === "SUCCEEDED");

  const issueSteps = byType("GOODS_ISSUE");
  for (const step of issueSteps) {
    if (step.status !== "SUCCEEDED") await runStep(claimedOrder, step);
  }
  const issueDone = allSucceeded(await prisma.productionCompletionStep.findMany({ where: { productionOrderId, stepType: "GOODS_ISSUE" } }));
  if (!issueDone) return;

  const receiptSteps = byType("GOODS_RECEIPT");
  for (const step of receiptSteps) {
    if (step.status !== "SUCCEEDED") await runStep(claimedOrder, step);
  }
  const receiptDone = allSucceeded(await prisma.productionCompletionStep.findMany({ where: { productionOrderId, stepType: "GOODS_RECEIPT" } }));
  if (!receiptDone) return;

  const fulfillmentSteps = byType("FULFILLMENT_UPDATE");
  for (const step of fulfillmentSteps) {
    if (step.status !== "SUCCEEDED") await runStep(claimedOrder, step);
  }
  const fulfillmentDone = allSucceeded(await prisma.productionCompletionStep.findMany({ where: { productionOrderId, stepType: "FULFILLMENT_UPDATE" } }));
  if (!fulfillmentDone) return;

  const billingSteps = byType("BILLING");
  for (const step of billingSteps) {
    if (step.status !== "SUCCEEDED") await runStep(claimedOrder, step);
  }
}

// §11 "MES Integration — Work-order dispatch; receive actual completion
// data — mes.*" / §5 stages 11-13. No real Siemens Opcenter/shop-floor MES
// exists here, so "dispatch" is simulated as reacting to schedule.published
// by logging (a real integration would push work orders over REST/Kafka to
// the actual MES); completion reporting is a real endpoint that writes
// genuine actual-vs-scheduled deviation data.
app.post("/mes/completions", async (req, res) => {
  const { scheduledOperationId, actualStart, actualEnd, goodUnits, totalUnits, rejectionReason } = req.body as {
    scheduledOperationId: string;
    actualStart: string;
    actualEnd: string;
    goodUnits?: number;
    totalUnits?: number;
    rejectionReason?: string | null;
  };

  const op = await prisma.scheduledOperation.findUnique({
    where: { id: scheduledOperationId },
    include: { routingOperation: true },
  });
  if (!op) {
    res.status(404).json({ error: "Scheduled operation not found" });
    return;
  }

  const actualEndDate = new Date(actualEnd);
  const deviationMinutes = Math.round((actualEndDate.getTime() - op.scheduledEnd.getTime()) / 60_000);
  const rejectedUnits = goodUnits != null && totalUnits != null ? Math.max(totalUnits - goodUnits, 0) : null;

  const updated = await prisma.scheduledOperation.update({
    where: { id: scheduledOperationId },
    data: {
      actualStart: new Date(actualStart),
      actualEnd: actualEndDate,
      deviationMinutes,
      status: "DONE",
      rejectionReason: rejectionReason || null,
      // Scrap-aware completion: previously these only ever reached
      // ClickHouse via the analytics forward below and were never
      // persisted here, so backflush/receipt/billing had no real actual
      // quantity to read back.
      goodUnits: goodUnits ?? null,
      rejectedUnits,
      totalUnits: totalUnits ?? null,
    },
  });

  if (op.machineId) {
    const total = totalUnits ?? 1;
    const good = goodUnits ?? total;
    const exceptions = await prisma.productionException.findMany({
      where: { scheduledOperationId, resolvedAt: { not: null } },
      select: { reportedAt: true, resolvedAt: true },
    });
    const downtimeMin = exceptions.reduce(
      (sum, e) => sum + Math.max((e.resolvedAt!.getTime() - e.reportedAt.getTime()) / 60_000, 0),
      0
    );
    try {
      await fetch(`${ANALYTICS_SERVICE_URL}/analytics/completed-operations`, {
        method: "POST",
        headers: { "content-type": "application/json", ...internalServiceHeaders() },
        body: JSON.stringify({
          operationId: updated.id,
          machineId: op.machineId,
          productionOrderId: updated.productionOrderId,
          scheduledStart: op.scheduledStart.toISOString(),
          scheduledEnd: op.scheduledEnd.toISOString(),
          actualStart,
          actualEnd,
          goodUnits: good,
          totalUnits: total,
          scrapUnits: Math.max(total - good, 0),
          setupTimeMin: op.routingOperation?.setupTimeMin ?? 0,
          processingTimeMin: op.routingOperation?.processingTimeMin ?? 0,
          downtimeMin,
        }),
      });
    } catch (error) {
      logger.warn("Failed to forward completion to analytics-service", { error: String(error) });
    }
  }

  const DEVIATION_THRESHOLD_MIN = 30;
  if (Math.abs(deviationMinutes) > DEVIATION_THRESHOLD_MIN) {
    logger.warn("Completion deviation exceeds threshold — reschedule may be warranted", {
      scheduledOperationId,
      deviationMinutes,
    });
  }

  const remainingOps = await prisma.scheduledOperation.count({
    where: { productionOrderId: updated.productionOrderId, status: { not: "DONE" } },
  });
  if (remainingOps === 0) {
    // Order-level actuals: the final operation's own reported totals are
    // what the whole order actually produced (this system completes an
    // order's operations together, not in separate batches — see
    // ProductionCompletionStep's schema comment on what that means for
    // GOODS_RECEIPT's idempotency key).
    const orderForActuals = await prisma.productionOrder.findUnique({ where: { id: updated.productionOrderId }, select: { quantity: true } });
    const actualGoodUnits = goodUnits ?? orderForActuals?.quantity ?? 0;
    const actualTotalUnits = totalUnits ?? orderForActuals?.quantity ?? 0;

    // The atomic gate (concurrent-duplicate-completion protection): only
    // one of any number of simultaneous completion signals for this order
    // wins this UPDATE. Everyone else gets null back and does nothing
    // further — no steps are planned, no side effects attempted.
    const claimed = await claimProductionOrderCompletion(updated.productionOrderId, actualGoodUnits, actualTotalUnits);
    if (claimed) {
      const planned = await planCompletionSteps(claimed);
      if (planned.length > 0) {
        // Durability guarantee: every planned step's PENDING row is
        // committed in the SAME transaction as nothing else being able to
        // re-win the CAS above — by the time this insert lands, the
        // obligation to attempt every one of these steps is permanent,
        // even if the process crashes on the very next line.
        await prisma.productionCompletionStep.createMany({
          data: planned.map((p) => ({ productionOrderId: claimed.id, stepType: p.stepType, stepKey: p.stepKey })),
          skipDuplicates: true,
        });
      }
      await attemptCompletionSteps(claimed.id);
    }
  }

  logger.info("MES completion recorded", { scheduledOperationId, deviationMinutes, goodUnits, totalUnits });
  res.json(updated);
});

// Recovery mechanism for a completion whose downstream steps didn't all
// finish (a failure was logged, the process crashed, or a step is still
// PENDING past its lease window) — re-attempts only what hasn't succeeded
// yet, in the same dependency order the original completion used. Safe to
// call any number of times, including concurrently with itself or with an
// in-flight inline completion: claimStep's atomic UPDATE is what actually
// prevents double-execution, not this endpoint's own serialization.
app.post("/production-orders/:id/retry-completion-steps", async (req, res) => {
  const productionOrderId = req.params.id as string;
  const order = await prisma.productionOrder.findUnique({ where: { id: productionOrderId } });
  if (!order) {
    res.status(404).json({ error: "Production order not found" });
    return;
  }
  if (order.status !== "COMPLETED") {
    res.status(409).json({ error: "Production order has not completed — nothing to retry" });
    return;
  }
  await attemptCompletionSteps(productionOrderId);
  const steps = await prisma.productionCompletionStep.findMany({ where: { productionOrderId }, orderBy: { createdAt: "asc" } });
  res.json({
    productionOrderId,
    steps: steps.map((s) => ({ stepType: s.stepType, stepKey: s.stepKey, status: s.status, attempts: s.attempts, lastError: s.lastError })),
  });
});

// Operator/ops-facing visibility into completions that didn't fully go
// through — "do not rely on error logs alone." Lists orders with at least
// one step that is FAILED, or stuck PENDING/IN_PROGRESS past the lease
// window (a crash between planning and attempting a step, or a crashed
// claim that hasn't been reclaimed yet).
app.get("/production-orders/completion-failures", async (_req, res) => {
  const leaseCutoff = new Date(Date.now() - LEASE_WINDOW_MINUTES * 60_000);
  const stuckSteps = await prisma.$queryRaw<{ productionOrderId: string; stepType: string; stepKey: string; status: string; lastError: string | null }[]>`
    SELECT "productionOrderId", "stepType", "stepKey", status, "lastError"
    FROM "ProductionCompletionStep"
    WHERE status = 'FAILED'
       OR (status = 'PENDING' AND "createdAt" < ${leaseCutoff})
       OR (status = 'IN_PROGRESS' AND "claimedAt" < ${leaseCutoff})
    ORDER BY "productionOrderId"
  `;
  const byOrder = new Map<string, typeof stuckSteps>();
  for (const s of stuckSteps) {
    if (!byOrder.has(s.productionOrderId)) byOrder.set(s.productionOrderId, []);
    byOrder.get(s.productionOrderId)!.push(s);
  }
  res.json({
    items: [...byOrder.entries()].map(([productionOrderId, steps]) => ({ productionOrderId, incompleteSteps: steps })),
  });
});

// Exported for direct unit testing of the completion-orchestration
// internals (the CAS, step claim/lease, and dependency gating) without
// needing every downstream service live — see app.test.ts.
export { claimProductionOrderCompletion, claimStep, planCompletionSteps, attemptCompletionSteps, LEASE_WINDOW_MINUTES };

registerErrorHandler(app);
