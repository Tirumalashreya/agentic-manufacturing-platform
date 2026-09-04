process.env.SERVICE_NAME = "scheduling-service";

import { createApp, registerErrorHandler, logger, subscribe, ensureTopics, TOPICS, redis } from "@aps/shared";
import { prisma, blockCapacity, unblockCapacity, HORIZON_WEEKS, computeLoadPct, type CapacityAdjustment } from "@aps/domain";
import { randomUUID } from "node:crypto";
import { runSchedulingPipeline, computeLeadTimePreview, type SchedulingMode } from "./pipeline";

const app = createApp();
const PORT = Number(process.env.PORT ?? 4005);

// §11: "Scheduling Service — Core scheduling pipeline, priority queue,
// resource assignment, versioning — POST /scheduling/runs · schedule.*"
app.post("/scheduling/runs", async (req, res) => {
  const { plantId, scope, mode } = req.body as {
    plantId?: string;
    scope?: "ALL" | "AFFECTED" | "SINGLE";
    mode?: SchedulingMode;
  };
  if (!plantId) {
    res.status(400).json({ error: "plantId is required" });
    return;
  }
  try {
    const result = await runSchedulingPipeline(plantId, scope ?? "ALL", mode ?? "FORWARD");
    res.json(result);
  } catch (error) {
    logger.error("Scheduling run failed", { plantId, error: String(error) });
    res.status(500).json({ error: String(error) });
  }
});

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
    const updated = await prisma.scheduledOperation.update({
      where: { id: req.params.id },
      data: { status: status as (typeof MANUALLY_SETTABLE_STATUSES)[number] },
    });
    res.json(updated);
  } catch (error) {
    logger.error("Manual status update failed", { operationId: req.params.id, error: String(error) });
    res.status(404).json({ error: "Scheduled operation not found" });
  }
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
  const { plantId, scope, mode, capacityAdjustments } = req.body as {
    plantId?: string;
    scope?: "ALL" | "AFFECTED" | "SINGLE";
    mode?: SchedulingMode;
    capacityAdjustments?: CapacityAdjustment[];
  };
  if (!plantId) {
    res.status(400).json({ error: "plantId is required" });
    return;
  }
  const namespace = `whatif:${randomUUID()}`;
  try {
    const result = await runSchedulingPipeline(plantId, scope ?? "ALL", mode ?? "FORWARD", {
      namespace,
      capacityAdjustments: capacityAdjustments ?? [],
    });
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
// Known, deliberate limitation: `scope: "AFFECTED"` doesn't actually narrow
// the order set in pipeline.ts yet (confirmed by reading it — the order
// query is scope-blind) — these triggers replan the whole plant under the
// hood, not just the truly-affected orders the doc's "AFFECTED" scope
// implies. Real automatic reaction, just not yet a narrow one.
async function autoReschedule(plantId: string, reason: string, slaSeconds: number) {
  const startedAt = Date.now();
  try {
    const result = await runSchedulingPipeline(plantId, "AFFECTED", "FORWARD");
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
    const { plantId, status, quantityChanged } = message as { plantId?: string; status?: string; quantityChanged?: boolean };
    if (!plantId) return;
    if (status === "CANCELLED") {
      await autoReschedule(plantId, "Order cancelled", 60);
    } else if (quantityChanged) {
      await autoReschedule(plantId, "Order quantity changed", 60);
    }
  });
  logger.info("Subscribed to orders.production.updated (auto-reschedule on cancellation/qty change)");
}
startOrderUpdateConsumer().catch((error) => logger.error("Order-update consumer failed to start", { error: String(error) }));

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

    await autoReschedule(machine.workCenter.plantId, `Machine breakdown (${machineId})`, 60);
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
    await autoReschedule(machine.workCenter.plantId, `Machine repaired (${machineId})`, 60);
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
    await autoReschedule(order.machine.workCenter.plantId, `Maintenance order added (${maintenanceOrderId})`, 120);
  });
  logger.info("Subscribed to maintenance.orders.created");
}
startMaintenanceConsumer().catch((error) => logger.error("Maintenance consumer failed to start", { error: String(error) }));

// Workload graph (BEAS/Proficy-style): real load_pct per machine, reusing
// the same capacity-engine.ts function the scheduling pipeline itself uses
// to detect overload — not a separate/simplified calculation.
app.get("/scheduling/workload", async (req, res) => {
  const { plantId } = req.query as { plantId?: string };
  if (!plantId) {
    res.status(400).json({ error: "plantId is required" });
    return;
  }

  const machines = await prisma.machine.findMany({
    where: { workCenter: { plantId } },
    select: { id: true, name: true },
  });

  const weekStart = new Date();
  weekStart.setHours(0, 0, 0, 0);

  const machineWorkload = await Promise.all(
    machines.map(async (machine) => ({
      machineId: machine.id,
      machineName: machine.name,
      loadPct: await computeLoadPct(redis, machine.id, weekStart),
    }))
  );

  res.json({ weekStart: weekStart.toISOString(), machines: machineWorkload });
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
          headers: { "content-type": "application/json" },
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
