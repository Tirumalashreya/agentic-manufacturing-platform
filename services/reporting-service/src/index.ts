process.env.SERVICE_NAME = "reporting-service";

import { createApp, registerErrorHandler, logger } from "@aps/shared";
import { prisma } from "@aps/domain";

const app = createApp();
const PORT = Number(process.env.PORT ?? 4016);

// §11: "Reporting Service — Schedule history, audit logs, KPI reports,
// deviation analysis — GET /reports/*"

app.get("/reports/schedule-history", async (req, res) => {
  const { plantId } = req.query as { plantId?: string };
  const schedules = await prisma.schedule.findMany({ where: { plantId }, orderBy: { versionNumber: "desc" } });
  res.json(schedules);
});

app.get("/reports/schedule-runs", async (req, res) => {
  const { plantId } = req.query as { plantId?: string };
  const runs = await prisma.scheduleRun.findMany({ where: { plantId }, orderBy: { startedAt: "desc" }, take: 50 });
  res.json(runs);
});

app.get("/reports/audit-log", async (req, res) => {
  const { entityType, entityId } = req.query as { entityType?: string; entityId?: string };
  const entries = await prisma.scheduleAuditLog.findMany({
    where: { entityType, entityId },
    orderBy: { logTimestamp: "desc" },
    take: 200,
  });
  res.json(entries);
});

// §10 "Average Tardiness" and "On-Time Delivery %" — computed directly from
// ProductionOrder/SalesOrder, the same source data the KPI table names.
app.get("/reports/deviation-analysis", async (req, res) => {
  const { plantId } = req.query as { plantId?: string };
  const orders = await prisma.productionOrder.findMany({
    where: { plantId, status: "COMPLETED", scheduledEnd: { not: null } },
    include: { salesOrder: true },
  });

  const withDueDate = orders.filter((o) => o.salesOrder);
  const lateOrders = withDueDate.filter((o) => o.scheduledEnd! > o.salesOrder!.dueDate);
  const onTimePct = withDueDate.length > 0 ? ((withDueDate.length - lateOrders.length) / withDueDate.length) * 100 : null;
  const avgTardinessMin =
    lateOrders.length > 0
      ? lateOrders.reduce((sum, o) => sum + (o.scheduledEnd!.getTime() - o.salesOrder!.dueDate.getTime()) / 60_000, 0) /
        lateOrders.length
      : 0;

  // §10 "Planned vs Actual Time = Actual_time / Planned_time × 100" — over
  // every completed ScheduledOperation in the plant with real MES-reported
  // actual times (not every DONE op necessarily has them).
  const doneOps = await prisma.scheduledOperation.findMany({
    where: {
      status: "DONE",
      actualStart: { not: null },
      actualEnd: { not: null },
      productionOrder: { plantId },
    },
    select: { scheduledStart: true, scheduledEnd: true, actualStart: true, actualEnd: true },
  });
  const plannedMin = doneOps.reduce(
    (sum, op) => sum + (op.scheduledEnd.getTime() - op.scheduledStart.getTime()) / 60_000,
    0
  );
  const actualMin = doneOps.reduce(
    (sum, op) => sum + (op.actualEnd!.getTime() - op.actualStart!.getTime()) / 60_000,
    0
  );
  const productivityPct = plannedMin > 0 ? (actualMin / plannedMin) * 100 : null;

  res.json({ totalOrders: withDueDate.length, lateOrders: lateOrders.length, onTimePct, avgTardinessMin, productivityPct });
});

registerErrorHandler(app);

app.listen(PORT, () => {
  logger.info(`reporting-service listening on :${PORT}`);
});
