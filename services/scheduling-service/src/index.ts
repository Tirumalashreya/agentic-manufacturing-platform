process.env.SERVICE_NAME = "scheduling-service";

import { createApp, registerErrorHandler, logger, subscribe, ensureTopics, publish, TOPICS, redis, internalServiceHeaders } from "@aps/shared";
import {
  prisma,
  blockCapacity,
  unblockCapacity,
  HORIZON_WEEKS,
  computeCapacityBreakdown,
  computeEffectiveCapacity,
  computeWeeklyBreakMinutes,
  sumClippedOverlapMinutes,
  narrowWindowsToShifts,
  narrowWindowsToHolidays,
  checkQcHold,
  type CapacityAdjustment,
} from "@aps/domain";
import { randomUUID } from "node:crypto";
import { runSchedulingPipeline, computeLeadTimePreview, resolveScopedOrderIds, type SchedulingMode } from "./pipeline";

const app = createApp();
const PORT = Number(process.env.PORT ?? 4005);

// §11: "Scheduling Service — Core scheduling pipeline, priority queue,
// resource assignment, versioning — POST /scheduling/runs · schedule.*"
app.post("/scheduling/runs", async (req, res) => {
  const { plantId, scope, mode, productionOrderId } = req.body as {
    plantId?: string;
    scope?: "ALL" | "AFFECTED" | "SINGLE";
    mode?: SchedulingMode;
    // Real, now-honored scoping (see pipeline.ts's resolveScopedOrderIds
    // doc comment) — required to actually narrow SINGLE/AFFECTED;
    // rejected below rather than silently falling through to ALL.
    productionOrderId?: string;
  };
  if (!plantId) {
    res.status(400).json({ error: "plantId is required" });
    return;
  }
  if ((scope === "SINGLE" || scope === "AFFECTED") && !productionOrderId) {
    res.status(400).json({ error: `productionOrderId is required when scope is ${scope}` });
    return;
  }
  try {
    const result = await runSchedulingPipeline(plantId, scope ?? "ALL", mode ?? "FORWARD", undefined, productionOrderId, "Manual reschedule");
    res.json(result);
  } catch (error) {
    logger.error("Scheduling run failed", { plantId, error: String(error) });
    res.status(500).json({ error: String(error) });
  }
});

// Real, read-only preview of what SINGLE/AFFECTED would actually touch —
// backed by the exact same resolveScopedOrderIds() the committing run
// above uses, so a caller (the APS Agent's approval-gate preview, in
// particular) can show a real target/affected-order list to a human
// before anything commits, without ever defining "affected" a second,
// possibly-divergent way.
app.get("/scheduling/affected-orders", async (req, res) => {
  const { plantId, productionOrderId, scope } = req.query as {
    plantId?: string;
    productionOrderId?: string;
    scope?: "AFFECTED" | "SINGLE";
  };
  if (!plantId || !productionOrderId) {
    res.status(400).json({ error: "plantId and productionOrderId are required" });
    return;
  }
  if (scope !== "AFFECTED" && scope !== "SINGLE") {
    res.status(400).json({ error: "scope must be AFFECTED or SINGLE" });
    return;
  }
  try {
    const { scopedOrderIds, targetOrderId } = await resolveScopedOrderIds(plantId, scope, productionOrderId);
    res.json({ scope, targetOrderId, scopedOrderIds: scopedOrderIds ?? [targetOrderId] });
  } catch (error) {
    logger.error("Affected-orders resolution failed", { plantId, productionOrderId, scope, error: String(error) });
    res.status(404).json({ error: String(error) });
  }
});

// Real QC-hold gate (Phase 4, agreed with the user) — the first
// execution-time predecessor check this codebase has ever had, scoped
// narrowly to only operations whose predecessor actually requiresInspection
// (checkQcHold's own logic short-circuits to feasible otherwise, so this is
// a true no-op for every other operation). Reuses the real
// RoutingOpDependency DAG pipeline.ts already walks for planned dates — no
// new sequencing concept. Extracted out of the status-PATCH route below
// (Phase 8, agreed with the user) so the write-time gate and the new
// read-only status route call the exact same logic rather than duplicating
// it — returns the first blocking predecessor found, matching the gate's
// own first-blocking-edge-wins behavior. Assumes the operation itself
// already exists (callers check that first).
async function getQcHoldStatus(scheduledOperationId: string): Promise<{ blocked: boolean; reason: string | null }> {
  const current = await prisma.scheduledOperation.findUnique({
    where: { id: scheduledOperationId },
    select: { productionOrderId: true, routingOperationId: true },
  });
  if (!current?.routingOperationId) return { blocked: false, reason: null };
  const predecessorEdges = await prisma.routingOpDependency.findMany({
    where: { successorId: current.routingOperationId },
    include: { predecessor: { select: { id: true, requiresInspection: true } } },
  });
  for (const edge of predecessorEdges) {
    if (!edge.predecessor.requiresInspection) continue;
    const sibling = await prisma.scheduledOperation.findFirst({
      where: { productionOrderId: current.productionOrderId, routingOperationId: edge.predecessor.id },
      select: { id: true },
    });
    if (!sibling) continue; // nothing real to gate on
    const latestInspection = await prisma.qualityInspection.findFirst({
      where: { scheduledOperationId: sibling.id },
      orderBy: { inspectedAt: "desc" },
      select: { result: true },
    });
    const gate = checkQcHold(true, latestInspection?.result ?? "PENDING");
    if (gate.feasible === false) {
      return { blocked: true, reason: gate.reason ?? "Predecessor operation is on QC hold" };
    }
  }
  return { blocked: false, reason: null };
}

// Manual status transitions an operator/planner triggers directly (Start,
// Block, or revert to Scheduled) — separate from POST /mes/completions
// (mes-integration), which is specifically for reporting a real completion
// with actual timing/quantities and forwarding deviation data to analytics.
// This endpoint is the simple "just move the status" path used by the Gantt
// hover-card actions and the demo auto-progress ticker.
const MANUALLY_SETTABLE_STATUSES = ["SCHEDULED", "IN_PROGRESS", "BLOCKED"] as const;
app.patch("/scheduling/operations/:id/status", async (req, res) => {
  const { status } = req.body as { status?: string };
  if (!status || !MANUALLY_SETTABLE_STATUSES.includes(status as (typeof MANUALLY_SETTABLE_STATUSES)[number])) {
    res.status(400).json({ error: `status must be one of ${MANUALLY_SETTABLE_STATUSES.join(", ")}` });
    return;
  }
  try {
    if (status === "IN_PROGRESS") {
      const exists = await prisma.scheduledOperation.findUnique({ where: { id: req.params.id }, select: { id: true } });
      if (!exists) {
        res.status(404).json({ error: "Scheduled operation not found" });
        return;
      }
      const hold = await getQcHoldStatus(req.params.id);
      if (hold.blocked) {
        res.status(409).json({ error: hold.reason });
        return;
      }
    }

    const updated = await prisma.scheduledOperation.update({
      where: { id: req.params.id },
      data: { status: status as (typeof MANUALLY_SETTABLE_STATUSES)[number] },
    });
    // The parent ProductionOrder's own status never moved past RELEASED
    // anywhere in this codebase — a real gap, since a stage-tracker UI
    // showing DRAFT/PLANNED/RELEASED/IN_PROGRESS/COMPLETED would otherwise
    // show every order frozen at RELEASED forever, even mid-production.
    // The order is genuinely "in progress" the moment its first operation
    // actually starts, so flip it here rather than only on the
    // all-operations-done side (see mes-integration's own COMPLETED write).
    if (status === "IN_PROGRESS") {
      await prisma.productionOrder.updateMany({
        where: { id: updated.productionOrderId, status: "RELEASED" },
        data: { status: "IN_PROGRESS" },
      });
      // Real downtime capture (agreed with the user, Phase 2) — closes
      // whatever exception(s) blocked this operation at the moment it
      // actually resumes, not a guess made when the exception was
      // reported. A no-op for a plain Start (SCHEDULED -> IN_PROGRESS,
      // nothing open to resolve). reportedAt..resolvedAt is what feeds
      // real downtime_min into OEE (see mes-integration's completions
      // handler).
      await prisma.productionException.updateMany({
        where: { scheduledOperationId: req.params.id, resolvedAt: null },
        data: { resolvedAt: new Date() },
      });
    }
    res.json(updated);
  } catch (error) {
    logger.error("Manual status update failed", { operationId: req.params.id, error: String(error) });
    res.status(404).json({ error: "Scheduled operation not found" });
  }
});

const EXCEPTION_TYPES = [
  "MACHINE_BREAKDOWN",
  "MATERIAL_SHORTAGE",
  "OPERATOR_UNAVAILABLE",
  "QUALITY_ISSUE",
  "MAINTENANCE",
  "BLOCKED",
  "OTHER",
] as const;

// Real production-exception capture (agreed with the user, Phase 1
// completion) — a real log row + a real Kafka publish, so this is
// genuinely event-driven, not a silent DB write. Deliberately does NOT
// call blockCapacity/autoReschedule itself: MACHINE_BREAKDOWN's real
// downstream effect is triggered by the CALLER (web/'s server action)
// reusing the EXISTING reportMachineBreakdown chain on machine-service —
// this route only ever persists+publishes, never reaches into
// scheduling's own capacity engine directly for this feature, keeping
// the one real breakdown trigger path singular.
app.post("/scheduling/operations/:id/exceptions", async (req, res) => {
  const { type, note } = req.body as { type?: string; note?: string | null };
  if (!type || !EXCEPTION_TYPES.includes(type as (typeof EXCEPTION_TYPES)[number])) {
    res.status(400).json({ error: `type must be one of ${EXCEPTION_TYPES.join(", ")}` });
    return;
  }
  try {
    const created = await prisma.productionException.create({
      data: { scheduledOperationId: req.params.id, type: type as (typeof EXCEPTION_TYPES)[number], note: note || null },
    });
    await publish(TOPICS.OPERATIONS_EXCEPTION_REPORTED, {
      exceptionId: created.id,
      scheduledOperationId: req.params.id,
      type: created.type,
      note: created.note,
    });
    res.status(201).json(created);
  } catch (error) {
    logger.error("Production exception create failed", { operationId: req.params.id, error: String(error) });
    res.status(404).json({ error: "Scheduled operation not found" });
  }
});

// Real, read-only — recent exceptions for a plant, joined to their real
// operation/order/machine, for the Production Planning page's Exceptions
// table. No aggregation invented; a plain recent list.
app.get("/scheduling/operations/exceptions", async (req, res) => {
  const { plantId } = req.query as { plantId?: string };
  if (!plantId) {
    res.status(400).json({ error: "plantId is required" });
    return;
  }
  const exceptions = await prisma.productionException.findMany({
    where: { scheduledOperation: { productionOrder: { plantId } } },
    orderBy: { reportedAt: "desc" },
    take: 50,
    include: {
      scheduledOperation: {
        include: {
          productionOrder: { select: { id: true } },
          routingOperation: { select: { operation: true } },
          machine: { select: { name: true } },
        },
      },
    },
  });
  res.json({
    items: exceptions.map((e) => ({
      id: e.id,
      type: e.type,
      note: e.note,
      reportedAt: e.reportedAt,
      resolvedAt: e.resolvedAt,
      productionOrderId: e.scheduledOperation.productionOrder.id,
      operation: e.scheduledOperation.routingOperation?.operation ?? null,
      machineName: e.scheduledOperation.machine?.name ?? null,
    })),
  });
});

const QC_RESULTS = ["PASS", "FAIL"] as const;

// Real Quality (Phase 4, agreed with the user) — a standalone action, not
// folded into Complete, since inspection can genuinely happen after
// completion (or be redone after rework). Only meaningful on an operation
// whose routing step actually requiresInspection, and only once it's real
// output exists to inspect (DONE). On FAIL, also creates a real
// ProductionException(QUALITY_ISSUE) — reuses Phase 1's exact mechanism
// rather than a parallel notification path, so it shows up in the
// existing Exceptions table for free.
app.post("/scheduling/operations/:id/quality-inspections", async (req, res) => {
  const { result, note } = req.body as { result?: string; note?: string | null };
  if (!result || !QC_RESULTS.includes(result as (typeof QC_RESULTS)[number])) {
    res.status(400).json({ error: `result must be one of ${QC_RESULTS.join(", ")}` });
    return;
  }
  const op = await prisma.scheduledOperation.findUnique({
    where: { id: req.params.id },
    include: { routingOperation: { select: { requiresInspection: true } } },
  });
  if (!op) {
    res.status(404).json({ error: "Scheduled operation not found" });
    return;
  }
  if (!op.routingOperation?.requiresInspection) {
    res.status(400).json({ error: "This operation's routing step does not require inspection" });
    return;
  }
  if (op.status !== "DONE") {
    res.status(400).json({ error: "Operation must be completed before it can be inspected" });
    return;
  }

  const created = await prisma.qualityInspection.create({
    data: { scheduledOperationId: op.id, result: result as (typeof QC_RESULTS)[number], note: note || null },
  });
  if (created.result === "FAIL") {
    const exception = await prisma.productionException.create({
      data: { scheduledOperationId: op.id, type: "QUALITY_ISSUE", note: note || null },
    });
    await publish(TOPICS.OPERATIONS_EXCEPTION_REPORTED, {
      exceptionId: exception.id,
      scheduledOperationId: op.id,
      type: exception.type,
      note: exception.note,
    });
  }
  await publish(TOPICS.QUALITY_INSPECTION_RECORDED, {
    inspectionId: created.id,
    scheduledOperationId: op.id,
    result: created.result,
    note: created.note,
  });
  res.status(201).json(created);
});

// Real, read-only — recent inspections for a plant, same shape as the
// exceptions list route, for the Production Planning page's Quality
// Inspections table.
app.get("/scheduling/operations/quality-inspections", async (req, res) => {
  const { plantId } = req.query as { plantId?: string };
  if (!plantId) {
    res.status(400).json({ error: "plantId is required" });
    return;
  }
  const inspections = await prisma.qualityInspection.findMany({
    where: { scheduledOperation: { productionOrder: { plantId } } },
    orderBy: { inspectedAt: "desc" },
    take: 50,
    include: {
      scheduledOperation: {
        include: {
          productionOrder: { select: { id: true } },
          routingOperation: { select: { operation: true } },
          machine: { select: { name: true } },
        },
      },
    },
  });
  res.json({
    items: inspections.map((i) => ({
      id: i.id,
      result: i.result,
      note: i.note,
      inspectedAt: i.inspectedAt,
      productionOrderId: i.scheduledOperation.productionOrder.id,
      operation: i.scheduledOperation.routingOperation?.operation ?? null,
      machineName: i.scheduledOperation.machine?.name ?? null,
    })),
  });
});

// Real, read-only (Phase 8, agreed with the user) — the exact same
// checkQcHold-based gate the status-PATCH route already runs as a side
// effect of a Start, exposed here as a pure read for the first time so a
// caller (the new Quality Agent, in particular) can ask "is this blocked"
// without attempting a Start.
app.get("/scheduling/operations/:id/quality-hold-status", async (req, res) => {
  const op = await prisma.scheduledOperation.findUnique({ where: { id: req.params.id }, select: { id: true } });
  if (!op) {
    res.status(404).json({ error: "Scheduled operation not found" });
    return;
  }
  const hold = await getQcHoldStatus(req.params.id);
  res.json(hold);
});

// Mirrors web/src/lib/lateness.ts's computeLatenessStatus exactly. That
// function lives in the web/ Next.js app, not a package scheduling-service
// can import, so the same small, already-agreed formula is reproduced here
// rather than silently diverging or inventing a different one.
function computeLatenessStatus(
  scheduledEnd: Date,
  dueDate: Date | null,
  actualEnd?: Date | null
): "LATE" | "AT_RISK" | "ON_TRACK" | "NO_DUE_DATE" {
  if (!dueDate) return "NO_DUE_DATE";
  const effectiveEnd = actualEnd ?? scheduledEnd;
  if (effectiveEnd.getTime() > dueDate.getTime()) return "LATE";
  const AT_RISK_BUFFER_MS = 24 * 60 * 60 * 1000;
  if (dueDate.getTime() - effectiveEnd.getTime() <= AT_RISK_BUFFER_MS) return "AT_RISK";
  return "ON_TRACK";
}

// Real, read-only, deterministic composition — no LLM, no new business
// logic (Phase 8, agreed with the user). Aggregates already-real facts
// (real ScheduleAuditLog history correlated via the productionOrderId
// already baked into its before/after JSON — same convention the Recovery
// page uses; real ProductionException history; real QualityInspection/
// QC-hold status per operation; real deviationMinutes; current lateness)
// for one order, so a downstream verdict-writer agent never computes
// anything itself, only explains what this route already assembled.
app.get("/scheduling/orders/:id/delay-explanation", async (req, res) => {
  const order = await prisma.productionOrder.findUnique({
    where: { id: req.params.id },
    include: {
      salesOrder: { select: { dueDate: true } },
      scheduledOperations: {
        orderBy: { scheduledStart: "asc" },
        include: {
          routingOperation: { select: { operation: true, requiresInspection: true } },
          machine: { select: { name: true } },
          exceptions: { orderBy: { reportedAt: "desc" }, take: 5 },
          qualityInspections: { orderBy: { inspectedAt: "desc" }, take: 1 },
        },
      },
    },
  });
  if (!order) {
    res.status(404).json({ error: "Production order not found" });
    return;
  }

  const dueDate = order.salesOrder?.dueDate ?? null;
  const latestEnd = order.scheduledOperations.reduce<Date | null>((latest, op) => {
    const effective = op.actualEnd ?? op.scheduledEnd;
    return !latest || effective > latest ? effective : latest;
  }, null);
  const latenessStatus = latestEnd ? computeLatenessStatus(latestEnd, dueDate) : "NO_DUE_DATE";

  const operations = await Promise.all(
    order.scheduledOperations.map(async (op) => ({
      id: op.id,
      operation: op.routingOperation?.operation ?? null,
      machineName: op.machine?.name ?? null,
      status: op.status,
      scheduledStart: op.scheduledStart,
      scheduledEnd: op.scheduledEnd,
      actualEnd: op.actualEnd,
      deviationMinutes: op.deviationMinutes,
      qcHold: op.routingOperation?.requiresInspection ? await getQcHoldStatus(op.id) : null,
      recentExceptions: op.exceptions.map((e) => ({ type: e.type, note: e.note, reportedAt: e.reportedAt, resolvedAt: e.resolvedAt })),
    }))
  );

  const auditHistory = await prisma.scheduleAuditLog.findMany({
    where: {
      entityType: "ScheduledOperation",
      OR: [
        { after: { path: ["productionOrderId"], equals: req.params.id } },
        { before: { path: ["productionOrderId"], equals: req.params.id } },
      ],
    },
    orderBy: { logTimestamp: "desc" },
    take: 20,
  });

  res.json({
    productionOrderId: order.id,
    salesOrderId: order.salesOrderId,
    dueDate,
    latenessStatus,
    operations,
    auditHistory: auditHistory.map((row) => ({ logTimestamp: row.logTimestamp, before: row.before, after: row.after })),
  });
});

// Lead-Time Scheduling: read-only rough-cut preview (no writes) — see
// computeLeadTimePreview's doc comment for why this is intentionally
// capacity-blind rather than a fifth value in SchedulingMode.
app.get("/scheduling/lead-time-preview", async (req, res) => {
  const { plantId } = req.query as { plantId?: string };
  if (!plantId) {
    res.status(400).json({ error: "plantId is required" });
    return;
  }
  try {
    const preview = await computeLeadTimePreview(plantId);
    res.json({ orders: preview });
  } catch (error) {
    logger.error("Lead-time preview failed", { plantId, error: String(error) });
    res.status(500).json({ error: String(error) });
  }
});

// What-If simulation: reuses the real Forward/Backward/Bottleneck engine
// against a scratch capacity namespace (unique per call, so concurrent
// what-if requests never interfere with each other or with real runs) and
// returns the simulated placements only — no ScheduleRun/ScheduledOperation/
// ResourceReservation is ever written. See pipeline.ts's WhatIfOptions and
// DryRunCtx for how the namespace/adjustment actually flow through the same
// placement code real runs use.
app.post("/scheduling/what-if", async (req, res) => {
  // AFFECTED-scope correctness fix (agreed with the user) — found while
  // verifying What-if stays zero-write after the autoReschedule fix below:
  // this endpoint accepted scope: "AFFECTED"/"SINGLE" but never read
  // productionOrderId from the body, so a caller using it the same way
  // POST /scheduling/runs does would silently get the same
  // AFFECTED-behaves-like-ALL bug in the dry-run preview. No real caller in
  // this codebase currently sends scope+productionOrderId here (both actual
  // callers -- the Disruption Simulator and apsAgent.simulateWhatIf -- always
  // simulate scope: "ALL" and filter the result down to one order
  // client-side), so this was latent, not live-traffic-affecting; fixed
  // anyway since it's the same one-line gap and a real caller could
  // reasonably expect this to behave like the committing endpoint does.
  const { plantId, scope, mode, productionOrderId, capacityAdjustments } = req.body as {
    plantId?: string;
    scope?: "ALL" | "AFFECTED" | "SINGLE";
    mode?: SchedulingMode;
    productionOrderId?: string;
    capacityAdjustments?: CapacityAdjustment[];
  };
  if (!plantId) {
    res.status(400).json({ error: "plantId is required" });
    return;
  }
  if ((scope === "SINGLE" || scope === "AFFECTED") && !productionOrderId) {
    res.status(400).json({ error: `productionOrderId is required when scope is ${scope}` });
    return;
  }
  const namespace = `whatif:${randomUUID()}`;
  try {
    const result = await runSchedulingPipeline(plantId, scope ?? "ALL", mode ?? "FORWARD", {
      namespace,
      capacityAdjustments: capacityAdjustments ?? [],
    }, productionOrderId);
    res.json(result);
  } catch (error) {
    logger.error("What-if simulation failed", { plantId, error: String(error) });
    res.status(500).json({ error: String(error) });
  } finally {
    // The scratch namespace's Redis keys (cap:whatif:<uuid>:* and
    // cap:idx:whatif:<uuid>:*) have no other owner and no TTL — clean them
    // up unconditionally so a burst of what-if calls doesn't leak Redis
    // memory. Runs whether the simulation succeeded, failed, or threw.
    const keys = await redis.keys(`cap:*${namespace}*`);
    if (keys.length > 0) await redis.del(...keys);
  }
});

// §14 Dynamic Rescheduling: the doc's whole premise is that disruptions
// trigger automatic replanning within an SLA, via event-driven consumers —
// not a human clicking "Run scheduling." Before this, `runSchedulingPipeline`
// was only ever invoked from the two HTTP routes (confirmed by grep); every
// one of the 5 Kafka consumers that existed anywhere in the repo stopped at
// logging or a side-effect write, never actually replanning. This helper is
// shared by the three consumers below so each one's "did we hit the SLA"
// logging is consistent.
//
// AFFECTED-scope correctness fix (agreed with the user): this used to always
// call runSchedulingPipeline with seedProductionOrderId left undefined, which
// resolveScopedOrderIds() (see pipeline.ts) treats identically to no scoping
// at all — every Kafka-triggered "AFFECTED" reschedule silently replanned the
// whole plant, indistinguishable from ALL, even though the API response kept
// reporting scope: "AFFECTED". Fixed at the call sites below, not here: each
// of the 4 triggers now resolves a real seed order before calling this
// (either a real orderId already carried on the event, or one derived from
// the disrupted machine's work center via findSeedOrderForWorkCenter) and
// passes it through as seedProductionOrderId.
async function autoReschedule(plantId: string, reason: string, slaSeconds: number, seedProductionOrderId?: string) {
  const startedAt = Date.now();
  try {
    const result = await runSchedulingPipeline(plantId, "AFFECTED", "FORWARD", undefined, seedProductionOrderId, reason);
    const elapsedMs = Date.now() - startedAt;
    const withinSla = elapsedMs <= slaSeconds * 1000;
    logger.info(`[AUTO-RESCHEDULE] ${reason}`, {
      plantId,
      elapsedMs,
      slaSeconds,
      withinSla,
      operationsScheduled: result.operationsScheduled,
      conflictsDetected: result.conflictsDetected,
    });
  } catch (error) {
    logger.error(`[AUTO-RESCHEDULE] ${reason} failed`, { plantId, error: String(error) });
  }
}

// §14 "Order Cancellation" (60s SLA) / "Order Qty Change" (60s SLA): react
// only to genuine disruptions, not every lifecycle status update (a routine
// RELEASED->IN_PROGRESS transition also publishes this same event and must
// NOT trigger a reschedule).
async function startOrderUpdateConsumer() {
  await ensureTopics([TOPICS.ORDERS_PRODUCTION_UPDATED]);
  await subscribe("scheduling-service-order-updates", [TOPICS.ORDERS_PRODUCTION_UPDATED], async (_topic, message) => {
    // orders.production.updated always carries the real orderId (see
    // order-service's publish call) — AFFECTED-scope fix: this was being
    // destructured away and never passed through, which is exactly why
    // AFFECTED silently became ALL for these two triggers.
    const { plantId, orderId, status, quantityChanged } = message as {
      plantId?: string; orderId?: string; status?: string; quantityChanged?: boolean;
    };
    if (!plantId) return;
    if (status === "CANCELLED") {
      await autoReschedule(plantId, "Order cancelled", 60, orderId);
    } else if (quantityChanged) {
      await autoReschedule(plantId, "Order quantity changed", 60, orderId);
    }
  });
  logger.info("Subscribed to orders.production.updated (auto-reschedule on cancellation/qty change)");
}
startOrderUpdateConsumer().catch((error) => logger.error("Order-update consumer failed to start", { error: String(error) }));

// AFFECTED-scope correctness fix (agreed with the user): machine-keyed
// triggers (breakdown/repair/maintenance) carry a machineId, never a
// productionOrderId, so there's no seed order sitting directly on the event
// the way orders.production.updated has one. This derives one using the
// exact same "shared work center" signal resolveScopedOrderIds() already
// applies (see pipeline.ts) — not a new definition of AFFECTED, just picking
// a real order that's already known to belong to that set. Any open order
// touching the work center works equally well as the seed: work-center
// sharing is symmetric, so resolveScopedOrderIds resolves the same affected
// set regardless of which one is picked. Returns null when no open order
// touches this work center at all — callers should skip the reschedule
// entirely in that case (there is nothing to replan), not fall back to ALL.
async function findSeedOrderForWorkCenter(plantId: string, workCenterId: string): Promise<string | null> {
  const order = await prisma.productionOrder.findFirst({
    where: {
      plantId,
      status: { in: ["PLANNED", "RELEASED"] },
      routing: { operations: { some: { workCenterId } } },
    },
    select: { id: true },
  });
  return order?.id ?? null;
}

// §14 "Machine Breakdown" (60s SLA): the doc's most time-critical trigger —
// a machine going DOWN mid-schedule needs the rest of the plant replanned
// around it immediately, not at the next manual run.
//
// Real gap this closes: this consumer used to only call autoReschedule,
// never blockCapacity — so a "down" machine's Redis buckets looked
// identical to an available one, and the reschedule that followed could
// still place new work on the very machine that just broke. The Maintenance
// consumer right below this one already did this correctly (block real
// capacity, THEN reschedule); breakdown now follows the exact same real-
// world pattern SAP/Proficy-style systems use for unplanned downtime — an
// immediate resource unavailability, same mechanism as planned maintenance,
// just unplanned and starting now instead of pre-scheduled.
async function startBreakdownConsumer() {
  await ensureTopics([TOPICS.MACHINES_BREAKDOWN_REPORTED]);
  await subscribe("scheduling-service-breakdown", [TOPICS.MACHINES_BREAKDOWN_REPORTED], async (_topic, message) => {
    const { machineId, eventId } = message as { machineId?: string; eventId?: string };
    if (!machineId) return;

    const machine = await prisma.machine.findUnique({ where: { id: machineId }, include: { workCenter: true } });
    if (!machine) {
      logger.warn("Machine not found for breakdown auto-reschedule", { machineId });
      return;
    }

    const event = eventId ? await prisma.machineEvent.findUnique({ where: { id: eventId } }) : null;
    const durationMinutes = event?.durationMinutes ?? 120; // fallback if no estimate was given
    const start = event?.eventTimestamp ?? new Date();
    await blockCapacity(redis, machineId, { start, end: new Date(start.getTime() + durationMinutes * 60_000) }, `Machine breakdown (${event?.faultCode ?? "unknown fault"})`);

    const seedOrderId = await findSeedOrderForWorkCenter(machine.workCenter.plantId, machine.workCenterId);
    if (seedOrderId) {
      await autoReschedule(machine.workCenter.plantId, `Machine breakdown (${machineId})`, 60, seedOrderId);
    } else {
      logger.info("No open production order touches the broken machine's work center — nothing to reschedule", { machineId, workCenterId: machine.workCenterId });
    }
  });
  logger.info("Subscribed to machines.breakdown.reported (auto-reschedule)");
}
startBreakdownConsumer().catch((error) => logger.error("Breakdown consumer failed to start", { error: String(error) }));

// Repair — the counterpart to the breakdown block above. A real "back
// online now" signal should reopen capacity immediately rather than wait
// for the original breakdown's duration estimate to elapse (it's only ever
// an estimate). Only reacts to a transition INTO "AVAILABLE" — every other
// status change (RUNNING, a routine day-to-day flip) has no capacity
// implication and must not trigger a reschedule.
async function startMachineAvailableConsumer() {
  await ensureTopics([TOPICS.MACHINES_STATUS_CHANGED]);
  await subscribe("scheduling-service-machine-available", [TOPICS.MACHINES_STATUS_CHANGED], async (_topic, message) => {
    const { machineId, status } = message as { machineId?: string; status?: string };
    if (!machineId || status !== "AVAILABLE") return;

    const machine = await prisma.machine.findUnique({ where: { id: machineId }, include: { workCenter: true } });
    if (!machine) return;

    const now = new Date();
    await unblockCapacity(redis, machineId, { start: now, end: new Date(now.getTime() + HORIZON_WEEKS * 7 * 86_400_000) });
    const seedOrderId = await findSeedOrderForWorkCenter(machine.workCenter.plantId, machine.workCenterId);
    if (seedOrderId) {
      await autoReschedule(machine.workCenter.plantId, `Machine repaired (${machineId})`, 60, seedOrderId);
    } else {
      logger.info("No open production order touches the repaired machine's work center — nothing to reschedule", { machineId, workCenterId: machine.workCenterId });
    }
  });
  logger.info("Subscribed to machines.status.changed (repair -> reopen capacity + reschedule)");
}
startMachineAvailableConsumer().catch((error) => logger.error("Machine-available consumer failed to start", { error: String(error) }));

// §14 "Maintenance Added — Create BLOCKED reservation; evaluate overlap;
// reschedule to alternatives or post-maintenance slot." Previously
// maintenance-service published this event but nothing consumed it — a
// MaintenanceOrder existed in Postgres yet never actually blocked capacity,
// so the scheduler would happily book real work during a machine's
// maintenance window. This consumer closes that gap: it blocks the real
// Redis capacity buckets for the window (so future runs skip it) and writes
// a COMMITTED MAINTENANCE ResourceReservation (so the GiST exclusion
// constraint rejects any operation that was already mid-placement) — and
// (new) actually replans afterward, within the doc's 120s SLA, instead of
// stopping at the capacity-block side effect.
async function startMaintenanceConsumer() {
  await ensureTopics([TOPICS.MAINTENANCE_ORDERS_CREATED]);
  await subscribe("scheduling-service-maintenance", [TOPICS.MAINTENANCE_ORDERS_CREATED], async (_topic, message) => {
    const { maintenanceOrderId } = message as { maintenanceOrderId?: string };
    if (!maintenanceOrderId) return;

    const order = await prisma.maintenanceOrder.findUnique({
      where: { id: maintenanceOrderId },
      include: { machine: { include: { workCenter: true } } },
    });
    if (!order) {
      logger.warn("Maintenance order not found for blocking", { maintenanceOrderId });
      return;
    }

    await blockCapacity(
      redis,
      order.machineId,
      { start: order.scheduledStart, end: order.scheduledEnd },
      `Maintenance order ${order.id} (${order.type})`
    );

    try {
      await prisma.resourceReservation.create({
        data: {
          resourceType: "MAINTENANCE",
          machineId: order.machineId,
          startTime: order.scheduledStart,
          endTime: order.scheduledEnd,
          state: "COMMITTED",
        },
      });
    } catch (error) {
      // A COMMITTED reservation already overlaps this machine/window (e.g. a
      // real production booking) — the exclusion constraint rejects the
      // insert. Capacity is still blocked going forward; the existing
      // conflicting booking is left for a planner to resolve rather than
      // silently cancelled.
      logger.warn("Could not commit MAINTENANCE reservation — an overlapping booking already exists", {
        maintenanceOrderId,
        error: String(error),
      });
    }

    logger.info("Capacity blocked for maintenance order", { maintenanceOrderId, machineId: order.machineId });
    const seedOrderId = await findSeedOrderForWorkCenter(order.machine.workCenter.plantId, order.machine.workCenterId);
    if (seedOrderId) {
      await autoReschedule(order.machine.workCenter.plantId, `Maintenance order added (${maintenanceOrderId})`, 120, seedOrderId);
    } else {
      logger.info("No open production order touches the maintenance machine's work center — nothing to reschedule", { maintenanceOrderId, workCenterId: order.machine.workCenterId });
    }
  });
  logger.info("Subscribed to maintenance.orders.created");
}
startMaintenanceConsumer().catch((error) => logger.error("Maintenance consumer failed to start", { error: String(error) }));

// Workload graph (BEAS/Proficy-style): real load_pct per machine, reusing
// the same capacity-engine.ts function the scheduling pipeline itself uses
// to detect overload — not a separate/simplified calculation.
// Real practical-capacity resolution (Phase 2, agreed with the user) — same
// Plant -> Work Center override -> fallback pattern pipeline.ts's own
// resolveCalendarForWorkCenter uses for real placement, so "how many
// minutes is this machine really available this week" matches the exact
// same calendar semantics real scheduling already places operations by,
// not a second, independently-invented notion of availability.
type WorkCenterCalendarInput = {
  workingDaysOfWeek: number[];
  holidayCalendarId: string | null;
  holidayCalendar: { holidays: { day: number; month: number; year: number }[] } | null;
};
function resolveWorkCenterCalendar(
  workCenter: WorkCenterCalendarInput,
  plantDayOverrides: Date[],
  plantHolidayCalendarDates: Date[],
  plantWorkingDaysOfWeek: number[] | null
): { holidayDates: Date[]; workingDaysOfWeek: number[] | null } {
  const workingDaysOfWeek = workCenter.workingDaysOfWeek.length > 0 ? workCenter.workingDaysOfWeek : plantWorkingDaysOfWeek;
  const holidayCalendarDates = workCenter.holidayCalendarId
    ? (workCenter.holidayCalendar?.holidays ?? []).map((h) => new Date(Date.UTC(h.year, h.month - 1, h.day)))
    : plantHolidayCalendarDates;
  return { holidayDates: [...plantDayOverrides, ...holidayCalendarDates], workingDaysOfWeek };
}

type MachineForCapacity = {
  id: string;
  name: string;
  workCenter: WorkCenterCalendarInput & {
    efficiencyFactor: number;
    shifts: { shift: { startTime: string; endTime: string; daysOfWeek: number[]; breakMinutes: number } }[];
  };
};

type PlantCalendarData = {
  plantDayOverrides: Date[];
  plantHolidayCalendarDates: Date[];
  plantWorkingDaysOfWeek: number[] | null;
};

// Same plant-level calendar resolution pipeline.ts's own real placement
// logic uses (see resolveCalendarForWorkCenter there) — every FactoryCalendar
// row for the plant, unioned, exactly as the pipeline already reads it.
// Plant-level (not week-dependent) — fetched once and reused across every
// week in a real multi-week rollup (Phase 5).
async function resolvePlantCalendarData(plantId: string): Promise<PlantCalendarData> {
  const factoryCalendars = await prisma.factoryCalendar.findMany({
    where: { plantId },
    include: { days: true, holidayCalendar: { include: { holidays: true } } },
  });
  const plantDayOverrides: Date[] = [];
  const plantHolidayCalendarDates: Date[] = [];
  for (const cal of factoryCalendars) {
    for (const d of cal.days) {
      if (d.isHoliday || !d.isWorking) plantDayOverrides.push(d.date);
    }
    for (const h of cal.holidayCalendar?.holidays ?? []) {
      plantHolidayCalendarDates.push(new Date(Date.UTC(h.year, h.month - 1, h.day)));
    }
  }
  return {
    plantDayOverrides,
    plantHolidayCalendarDates,
    plantWorkingDaysOfWeek: factoryCalendars[0]?.workingDaysOfWeek ?? null,
  };
}

// Real per-machine capacity for ONE real 7-day window (Phase 2, extended in
// Phase 5 to be callable for any weekStart, not just "this week" — pure
// extraction of the exact logic GET /scheduling/workload always ran;
// output is byte-for-byte the same for week 1 as before this extraction).
async function computeMachineCapacityForWeek(machines: MachineForCapacity[], plantCalendar: PlantCalendarData, weekStart: Date, weekEnd: Date) {
  const machineIds = machines.map((m) => m.id);

  // Real maintenance overlap for the week, batched across every machine at
  // once (one query) rather than N+1 per machine.
  const maintenanceOrders = await prisma.maintenanceOrder.findMany({
    where: { machineId: { in: machineIds }, scheduledStart: { lt: weekEnd }, scheduledEnd: { gt: weekStart } },
    select: { machineId: true, scheduledStart: true, scheduledEnd: true },
  });
  const maintenanceByMachine = new Map<string, { start: Date; end: Date }[]>();
  for (const mo of maintenanceOrders) {
    const list = maintenanceByMachine.get(mo.machineId) ?? [];
    list.push({ start: mo.scheduledStart, end: mo.scheduledEnd });
    maintenanceByMachine.set(mo.machineId, list);
  }

  // Real, resolved (never guessed) downtime for the week — see
  // ProductionException.resolvedAt, closed only when an operation actually
  // resumes (scheduling-service's own status PATCH route above).
  const resolvedExceptions = await prisma.productionException.findMany({
    where: {
      resolvedAt: { not: null },
      reportedAt: { lt: weekEnd },
      scheduledOperation: { machineId: { in: machineIds } },
    },
    select: { reportedAt: true, resolvedAt: true, scheduledOperation: { select: { machineId: true } } },
  });
  const downtimeByMachine = new Map<string, { start: Date; end: Date }[]>();
  for (const e of resolvedExceptions) {
    const machineId = e.scheduledOperation.machineId;
    if (!machineId) continue;
    const list = downtimeByMachine.get(machineId) ?? [];
    list.push({ start: e.reportedAt, end: e.resolvedAt! });
    downtimeByMachine.set(machineId, list);
  }

  return Promise.all(
    machines.map(async (machine) => {
      const shifts = machine.workCenter.shifts.map((s) => s.shift);
      const calendar = resolveWorkCenterCalendar(
        machine.workCenter,
        plantCalendar.plantDayOverrides,
        plantCalendar.plantHolidayCalendarDates,
        plantCalendar.plantWorkingDaysOfWeek
      );
      let windows = narrowWindowsToShifts([{ start: weekStart, end: weekEnd }], shifts, weekStart, weekEnd, 0);
      windows = narrowWindowsToHolidays(windows, calendar.holidayDates, calendar.workingDaysOfWeek, 0);
      const shiftMinutes = windows.reduce((sum, w) => sum + (w.end.getTime() - w.start.getTime()) / 60_000, 0);

      const breakMin = computeWeeklyBreakMinutes(shifts);
      const maintenanceMin = sumClippedOverlapMinutes(maintenanceByMachine.get(machine.id) ?? [], weekStart, weekEnd);
      const downtimeMin = sumClippedOverlapMinutes(downtimeByMachine.get(machine.id) ?? [], weekStart, weekEnd);
      const availabilityFactor = shiftMinutes > 0 ? Math.min(Math.max((shiftMinutes - downtimeMin) / shiftMinutes, 0), 1) : 1;

      const effectiveCapacityMin = computeEffectiveCapacity({
        shiftMin: shiftMinutes,
        breakMin,
        maintenanceMin,
        efficiencyFactor: machine.workCenter.efficiencyFactor,
        availabilityFactor,
      });

      const breakdown = await computeCapacityBreakdown(redis, machine.id, weekStart, effectiveCapacityMin);

      return {
        machineId: machine.id,
        machineName: machine.name,
        loadPct: breakdown.loadPct,
        effectiveLoadPct: breakdown.effectiveLoadPct,
        availabilityFactor,
        effectiveCapacityMin,
        usedMin: breakdown.usedMin,
      };
    })
  );
}

const MACHINE_CAPACITY_SELECT = {
  id: true,
  name: true,
  workCenter: {
    select: {
      efficiencyFactor: true,
      workingDaysOfWeek: true,
      holidayCalendarId: true,
      holidayCalendar: { select: { holidays: { select: { day: true, month: true, year: true } } } },
      shifts: { select: { shift: { select: { startTime: true, endTime: true, daysOfWeek: true, breakMinutes: true } } } },
    },
  },
} as const;

app.get("/scheduling/workload", async (req, res) => {
  const { plantId } = req.query as { plantId?: string };
  if (!plantId) {
    res.status(400).json({ error: "plantId is required" });
    return;
  }

  const machines = await prisma.machine.findMany({ where: { workCenter: { plantId } }, select: MACHINE_CAPACITY_SELECT });
  const weekStart = new Date();
  weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000);

  const plantCalendar = await resolvePlantCalendarData(plantId);
  const perMachine = await computeMachineCapacityForWeek(machines, plantCalendar, weekStart, weekEnd);

  res.json({
    weekStart: weekStart.toISOString(),
    machines: perMachine.map(({ machineId, machineName, loadPct, effectiveLoadPct, availabilityFactor }) => ({
      machineId,
      machineName,
      loadPct,
      effectiveLoadPct,
      availabilityFactor,
    })),
  });
});

// Real multi-week capacity rollup (Phase 5, agreed with the user) — same
// exact per-week computation as GET /scheduling/workload above, called for
// `weeks` consecutive real 7-day windows anchored the identical way (today,
// chained forward). Capped at HORIZON_WEEKS (13) — beyond that, real
// Redis/ScheduledOperation data structurally doesn't exist (see
// pipeline.ts's own PLANNING_HORIZON_DAYS), so returning more would be
// fabricated, not real.
app.get("/scheduling/capacity-rollup", async (req, res) => {
  const { plantId } = req.query as { plantId?: string };
  if (!plantId) {
    res.status(400).json({ error: "plantId is required" });
    return;
  }
  const weeks = Math.min(Math.max(Number(req.query.weeks) || HORIZON_WEEKS, 1), HORIZON_WEEKS);

  const machines = await prisma.machine.findMany({ where: { workCenter: { plantId } }, select: MACHINE_CAPACITY_SELECT });
  const plantCalendar = await resolvePlantCalendarData(plantId);

  const baseWeekStart = new Date();
  baseWeekStart.setHours(0, 0, 0, 0);

  const weekResults = [];
  for (let i = 0; i < weeks; i++) {
    const weekStart = new Date(baseWeekStart.getTime() + i * 7 * 86_400_000);
    const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000);
    const perMachine = await computeMachineCapacityForWeek(machines, plantCalendar, weekStart, weekEnd);
    weekResults.push({ weekStart: weekStart.toISOString(), machines: perMachine });
  }

  res.json({ weeks: weekResults });
});

// Real multi-week demand rollup (Phase 5, agreed with the user) — real
// ProductionOrder.quantity, bucketed by its real scheduledStart (only
// orders the pipeline has actually placed show up — an unscheduled order's
// future week is genuinely unknown, so it's honestly omitted rather than
// guessed). Excludes CANCELLED orders.
app.get("/scheduling/demand-rollup", async (req, res) => {
  const { plantId } = req.query as { plantId?: string };
  if (!plantId) {
    res.status(400).json({ error: "plantId is required" });
    return;
  }
  const weeks = Math.min(Math.max(Number(req.query.weeks) || HORIZON_WEEKS, 1), HORIZON_WEEKS);

  const baseWeekStart = new Date();
  baseWeekStart.setHours(0, 0, 0, 0);
  const rangeEnd = new Date(baseWeekStart.getTime() + weeks * 7 * 86_400_000);

  const orders = await prisma.productionOrder.findMany({
    where: { plantId, status: { not: "CANCELLED" }, scheduledStart: { gte: baseWeekStart, lt: rangeEnd } },
    select: { quantity: true, scheduledStart: true, product: { select: { sku: true } } },
  });

  const weekResults = Array.from({ length: weeks }, (_, i) => {
    const weekStart = new Date(baseWeekStart.getTime() + i * 7 * 86_400_000);
    return { weekStart: weekStart.toISOString(), totalQuantity: 0, byProduct: new Map<string, number>() };
  });
  for (const order of orders) {
    if (!order.scheduledStart) continue;
    const weekIndex = Math.floor((order.scheduledStart.getTime() - baseWeekStart.getTime()) / (7 * 86_400_000));
    const bucket = weekResults[weekIndex];
    if (!bucket) continue;
    bucket.totalQuantity += order.quantity;
    bucket.byProduct.set(order.product.sku, (bucket.byProduct.get(order.product.sku) ?? 0) + order.quantity);
  }

  res.json({
    weeks: weekResults.map((w) => ({
      weekStart: w.weekStart,
      totalQuantity: w.totalQuantity,
      byProduct: [...w.byProduct.entries()].map(([sku, quantity]) => ({ sku, quantity })),
    })),
  });
});

// Demo auto-progress ticker — OFF by default, opt-in only via
// DEMO_AUTO_PROGRESS=true. There is no real shop-floor system behind this
// app to report actual status changes (see the "no automatic status
// transition mechanism" finding this was built in response to), so this
// simulates one: on an accelerated clock (DEMO_TIME_SCALE, default 60x — 1
// real minute = 1 simulated hour), it walks every SCHEDULED/IN_PROGRESS
// operation and advances it exactly the way a human clicking the Gantt's
// Start/Complete buttons would — by calling those SAME real endpoints
// (this service's own /scheduling/operations/:id/status, and
// mes-integration's /mes/completions), not a separate shortcut path. Must
// never run unset in a real deployment; the explicit env-var gate and the
// loud startup log line are both deliberate about that.
// Mutable at runtime (via the two endpoints below) so the Disruption
// Simulator panel can flip it from the UI — the env var only sets the
// STARTING value now, not a permanent one-way gate.
let demoTickerEnabled = process.env.DEMO_AUTO_PROGRESS === "true";
const DEMO_TIME_SCALE = Number(process.env.DEMO_TIME_SCALE ?? 60);
const DEMO_TICK_MS = 10_000;
const MES_INTEGRATION_URL = process.env.MES_INTEGRATION_URL ?? "http://localhost:4019";

async function demoAutoProgressTick() {
  const ops = await prisma.scheduledOperation.findMany({
    where: { status: { in: ["SCHEDULED", "IN_PROGRESS"] } },
    include: { productionOrder: { select: { quantity: true } } },
  });

  const now = Date.now();
  for (const op of ops) {
    const realElapsedSinceStartMs = now - op.scheduledStart.getTime();
    if (realElapsedSinceStartMs < 0) continue; // not due to start yet, even accelerated

    const simulatedElapsedMs = realElapsedSinceStartMs * DEMO_TIME_SCALE;
    const durationMs = op.scheduledEnd.getTime() - op.scheduledStart.getTime();

    try {
      if (op.status === "SCHEDULED" && simulatedElapsedMs < durationMs) {
        await prisma.scheduledOperation.update({ where: { id: op.id }, data: { status: "IN_PROGRESS" } });
        logger.info("[DEMO] operation started", { operationId: op.id });
      } else if (op.status !== "DONE" && simulatedElapsedMs >= durationMs) {
        await fetch(`${MES_INTEGRATION_URL}/mes/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", ...internalServiceHeaders() },
          body: JSON.stringify({
            scheduledOperationId: op.id,
            actualStart: op.scheduledStart.toISOString(),
            actualEnd: new Date().toISOString(),
            goodUnits: op.productionOrder.quantity,
            totalUnits: op.productionOrder.quantity,
          }),
        });
        logger.info("[DEMO] operation completed", { operationId: op.id });
      }
    } catch (error) {
      logger.warn("[DEMO] auto-progress tick failed for one operation", { operationId: op.id, error: String(error) });
    }
  }
}

if (demoTickerEnabled) {
  logger.info(`[DEMO] Auto-progress ticker ENABLED at startup — DEMO_TIME_SCALE=${DEMO_TIME_SCALE}x. This is a simulated shop floor, not real production behavior.`);
}
// The interval always runs so the runtime toggle below can turn the ticker
// on/off without a service restart — it no-ops every tick while disabled.
setInterval(() => {
  if (!demoTickerEnabled) return;
  demoAutoProgressTick().catch((error) => logger.error("[DEMO] auto-progress tick failed", { error: String(error) }));
}, DEMO_TICK_MS);

app.get("/scheduling/demo-ticker", (_req, res) => {
  res.json({ enabled: demoTickerEnabled, timeScale: DEMO_TIME_SCALE });
});

app.patch("/scheduling/demo-ticker", (req, res) => {
  const { enabled } = req.body as { enabled: boolean };
  demoTickerEnabled = enabled;
  logger.info(`[DEMO] Auto-progress ticker ${enabled ? "ENABLED" : "DISABLED"} via API`);
  res.json({ enabled: demoTickerEnabled });
});

registerErrorHandler(app);

app.listen(PORT, () => {
  logger.info(`scheduling-service listening on :${PORT}`);
});
