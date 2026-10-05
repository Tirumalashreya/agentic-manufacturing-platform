process.env.SERVICE_NAME = "mes-integration";

import { createApp, registerErrorHandler, logger, subscribe, ensureTopics, publish, TOPICS, internalServiceHeaders } from "@aps/shared";
import { prisma } from "@aps/domain";

const app = createApp();
const PORT = Number(process.env.PORT ?? 4019);
const ANALYTICS_SERVICE_URL = process.env.ANALYTICS_SERVICE_URL ?? "http://localhost:4017";
// A real gap found live: completing an operation never closed the loop
// back to Order-to-Cash — nothing created a delivery/invoice for a
// produced order once the shop floor actually finished it (only MTS/
// HYBRID's stock leg got that, via the Python side's own reserve+bill
// path). This is the first call in the reverse direction (TS -> Python)
// in this codebase — every other integration this session has been
// Python calling out to these services, never the other way. Same
// "${SERVICE}_URL, localhost fallback" convention as every other
// outbound call in this repo, just pointed at agent-orchestrator instead
// of another TS service.
const AGENT_ORCHESTRATOR_URL = process.env.AGENT_ORCHESTRATOR_URL ?? "http://localhost:8000";

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
    // Real scrap/rejection capture (agreed with the user) — only
    // meaningful when totalUnits > goodUnits; stored on the
    // ScheduledOperation itself (APS owns this, per the standing
    // architecture principle), not forwarded to analytics-service
    // (ClickHouse's completed_operations table already carries the real
    // quantitative goodUnits/totalUnits/scrapUnits signal; the reason
    // text is an operational detail, not an OLAP metric).
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

  const updated = await prisma.scheduledOperation.update({
    where: { id: scheduledOperationId },
    data: {
      actualStart: new Date(actualStart),
      actualEnd: actualEndDate,
      deviationMinutes,
      status: "DONE",
      rejectionReason: rejectionReason || null,
    },
  });

  // §5 stage 12→13: feed real completion data into the analytics OLAP store
  // (analytics-service / ClickHouse) so OEE/scrap/bottleneck queries have
  // something to compute against — previously this endpoint updated Postgres
  // but never forwarded to analytics-service, leaving completed_operations
  // permanently empty.
  if (op.machineId) {
    const total = totalUnits ?? 1;
    const good = goodUnits ?? total;
    // Real downtime capture (agreed with the user, Phase 2) — replaces the
    // previous hardcoded 0, which made OEE Availability mathematically
    // always 100%. Sums real, closed (resolvedAt set) exception intervals
    // for this exact operation — reportedAt..resolvedAt is a real elapsed
    // duration, set only when the operation actually resumed (see
    // scheduling-service's status PATCH route), never a guess.
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

  // §5 stage 13 "Feedback Processor: MES completion events → Deviation
  // computed → rescheduling trigger if deviation > threshold" (§14: machine
  // breakdown/order changes already have their own dedicated triggers
  // elsewhere; a large *completion* deviation on one op is the remaining
  // case, logged here rather than auto-replanning the whole plant for it).
  const DEVIATION_THRESHOLD_MIN = 30;
  if (Math.abs(deviationMinutes) > DEVIATION_THRESHOLD_MIN) {
    logger.warn("Completion deviation exceeds threshold — reschedule may be warranted", {
      scheduledOperationId,
      deviationMinutes,
    });
  }

  // Closes the produced-order Order-to-Cash loop: once EVERY operation
  // on this production order is DONE, the order is actually finished —
  // notify agent-orchestrator so it can create a real delivery + invoice
  // for the produced quantity, the same way MTS/HYBRID's stock leg
  // already gets one. Best-effort (matches this file's own existing
  // philosophy for the analytics forward above) — a notification failure
  // doesn't fail the completion itself; the order stays real and DONE in
  // Postgres regardless, this is just the downstream billing trigger.
  const remainingOps = await prisma.scheduledOperation.count({
    where: { productionOrderId: updated.productionOrderId, status: { not: "DONE" } },
  });
  if (remainingOps === 0) {
    // Same real gap as scheduling-service's IN_PROGRESS write on Start —
    // nothing ever moved ProductionOrder.status to COMPLETED either, so a
    // stage-tracker UI would show a finished order stuck at IN_PROGRESS
    // forever. This IS the moment it's actually done — every real
    // operation reported DONE — so write it here, before notifying
    // agent-orchestrator for billing.
    const completedOrder = await prisma.productionOrder.update({
      where: { id: updated.productionOrderId },
      data: { status: "COMPLETED" },
    });

    // Real Goods Issue (Phase 3, agreed with the user) — backflushed at
    // order completion (the standard ERP pattern, avoiding per-operation
    // partial-BOM tracking): the order's BOM says exactly what quantity of
    // each component a finished order of this size consumed, so issue it
    // for real now, same "quantityPer × orderQty" math
    // checkShortagesForProduct already uses. Best-effort — a goods-issue
    // failure must never block a legitimate completion or the billing
    // notification below.
    try {
      const bom = completedOrder.bomId
        ? await prisma.bOM.findUnique({ where: { id: completedOrder.bomId }, include: { lines: true } })
        : await prisma.bOM.findFirst({ where: { productId: completedOrder.productId }, include: { lines: true } });
      if (bom) {
        const plant = await prisma.plant.findUnique({ where: { id: completedOrder.plantId }, select: { code: true } });
        const location = plant?.code;
        if (location) {
          for (const line of bom.lines) {
            const requiredQty = line.quantityPer * completedOrder.quantity;
            const existing = await prisma.inventory.findUnique({
              where: { productId_location: { productId: line.componentId, location } },
            });
            // Floor at 0 — never go negative. Scheduling already gated on
            // availability at planning time, but real stock can genuinely
            // have moved since (same defensive read-then-clamp-then-write
            // shape as capacity-engine.ts's releaseCapacity).
            const newQty = Math.max((existing?.qtyUnrestricted ?? 0) - requiredQty, 0);
            await prisma.inventory.upsert({
              where: { productId_location: { productId: line.componentId, location } },
              create: { productId: line.componentId, location, qtyUnrestricted: newQty, qtyReserved: 0, qtyInTransit: 0 },
              update: { qtyUnrestricted: newQty },
            });
            const movement = await prisma.inventoryMovement.create({
              data: {
                type: "GOODS_ISSUE",
                productId: line.componentId,
                location,
                quantity: requiredQty,
                productionOrderId: completedOrder.id,
              },
            });
            await publish(TOPICS.INVENTORY_MOVEMENT_RECORDED, {
              movementId: movement.id,
              type: movement.type,
              productId: movement.productId,
              location: movement.location,
              quantity: movement.quantity,
              productionOrderId: completedOrder.id,
            });
          }
        }
      }
    } catch (error) {
      logger.warn("Failed to record goods issue for completed production order", {
        productionOrderId: completedOrder.id,
        error: String(error),
      });
    }

    try {
      const response = await fetch(`${AGENT_ORCHESTRATOR_URL}/production-orders/${updated.productionOrderId}/complete`, {
        method: "POST",
        headers: internalServiceHeaders(),
      });
      if (!response.ok) {
        logger.warn("agent-orchestrator declined production order completion notice", {
          productionOrderId: updated.productionOrderId,
          status: response.status,
        });
      } else {
        logger.info("Production order fully complete — notified agent-orchestrator for delivery/billing", {
          productionOrderId: updated.productionOrderId,
        });
      }
    } catch (error) {
      logger.warn("Failed to notify agent-orchestrator of production order completion", { error: String(error) });
    }
  }

  logger.info("MES completion recorded", { scheduledOperationId, deviationMinutes, goodUnits, totalUnits });
  res.json(updated);
});

async function startConsumer() {
  await ensureTopics([TOPICS.SCHEDULE_PUBLISHED]);
  await subscribe("mes-integration", [TOPICS.SCHEDULE_PUBLISHED], async (_topic, message) => {
    logger.info("Simulated work-order dispatch to shop-floor MES", message);
  });
  logger.info("Subscribed to schedule.published");
}
startConsumer().catch((error) => logger.error("Kafka consumer failed to start", { error: String(error) }));

registerErrorHandler(app);

app.listen(PORT, () => {
  logger.info(`mes-integration listening on :${PORT}`);
});
