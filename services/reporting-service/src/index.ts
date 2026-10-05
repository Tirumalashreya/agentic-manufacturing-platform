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
// Real, optional from/to window (Phase 5, agreed with the user) — omitting
// both preserves the exact previous all-time behavior (Prisma drops
// undefined filter keys), so the base route's existing callers see zero
// change. Extracted so the new weekly rollup below can reuse the identical
// math per window instead of a second, possibly-diverging copy.
async function computeDeviationMetrics(plantId: string | undefined, from?: Date, to?: Date) {
  const orders = await prisma.productionOrder.findMany({
    where: { plantId, status: "COMPLETED", scheduledEnd: { not: null, gte: from, lt: to } },
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
  // actual times (not every DONE op necessarily has them). Bucketed by
  // actualEnd (when the real completion happened), not scheduledEnd — the
  // on-time math above stays anchored to scheduledEnd since that's what
  // "did the PLAN land on time" means.
  const doneOps = await prisma.scheduledOperation.findMany({
    where: {
      status: "DONE",
      actualStart: { not: null },
      actualEnd: { not: null, gte: from, lt: to },
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

  // plannedMin/actualMin exposed alongside the pct (Phase 5) so a caller
  // aggregating several weeks into a coarser period (e.g. a real Monthly
  // view) can sum real minutes across weeks and divide once, rather than
  // averaging per-week percentages — same reasoning as capacity-engine.ts's
  // computeCapacityBreakdown this session.
  return { totalOrders: withDueDate.length, lateOrders: lateOrders.length, onTimePct, avgTardinessMin, productivityPct, plannedMin, actualMin };
}

app.get("/reports/deviation-analysis", async (req, res) => {
  const { plantId, from, to } = req.query as { plantId?: string; from?: string; to?: string };
  const result = await computeDeviationMetrics(plantId, from ? new Date(from) : undefined, to ? new Date(to) : undefined);
  res.json(result);
});

// Real multi-week Plan vs Actual trend (Phase 5, agreed with the user) —
// same exact math as deviation-analysis above, bucketed into `weeks` real
// trailing 7-day windows (i=0 is the current week, going backward) — this
// is inherently a historical/backward-looking view (you can only measure
// what already happened), unlike the forward-looking capacity/demand
// rollups. Same "today, setHours(0,0,0,0)" anchor convention as those.
app.get("/reports/deviation-rollup", async (req, res) => {
  const { plantId } = req.query as { plantId?: string };
  const weeks = Math.min(Math.max(Number(req.query.weeks) || 13, 1), 13);

  const baseWeekStart = new Date();
  baseWeekStart.setHours(0, 0, 0, 0);

  const weekResults = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const weekStart = new Date(baseWeekStart.getTime() - i * 7 * 86_400_000);
    const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000);
    const metrics = await computeDeviationMetrics(plantId, weekStart, weekEnd);
    weekResults.push({ weekStart: weekStart.toISOString(), ...metrics });
  }

  res.json({ weeks: weekResults });
});

registerErrorHandler(app);

app.listen(PORT, () => {
  logger.info(`reporting-service listening on :${PORT}`);
});
