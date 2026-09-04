process.env.SERVICE_NAME = "mes-integration";

import { createApp, registerErrorHandler, logger, subscribe, ensureTopics, TOPICS } from "@aps/shared";
import { prisma } from "@aps/domain";

const app = createApp();
const PORT = Number(process.env.PORT ?? 4019);
const ANALYTICS_SERVICE_URL = process.env.ANALYTICS_SERVICE_URL ?? "http://localhost:4017";

// §11 "MES Integration — Work-order dispatch; receive actual completion
// data — mes.*" / §5 stages 11-13. No real Siemens Opcenter/shop-floor MES
// exists here, so "dispatch" is simulated as reacting to schedule.published
// by logging (a real integration would push work orders over REST/Kafka to
// the actual MES); completion reporting is a real endpoint that writes
// genuine actual-vs-scheduled deviation data.
app.post("/mes/completions", async (req, res) => {
  const { scheduledOperationId, actualStart, actualEnd, goodUnits, totalUnits } = req.body as {
    scheduledOperationId: string;
    actualStart: string;
    actualEnd: string;
    goodUnits?: number;
    totalUnits?: number;
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
    try {
      await fetch(`${ANALYTICS_SERVICE_URL}/analytics/completed-operations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
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
          downtimeMin: 0,
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
