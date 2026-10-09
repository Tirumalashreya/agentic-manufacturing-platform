process.env.SERVICE_NAME = "maintenance-service";

import { createApp, registerErrorHandler, logger, publishTracked, TOPICS } from "@aps/shared";
import { prisma } from "@aps/domain";

// Split out of index.ts (Stage 01 HIGH-risk debt closure — same pattern as
// order-service/machine-service) so vitest+supertest can exercise this
// app without binding the real port.
export const app = createApp();

// §11: "Maintenance Service — PM plans, maintenance orders, breakdown
// integration — maintenance.orders.created"

app.get("/maintenance-orders", async (req, res) => {
  const { machineId } = req.query as { machineId?: string };
  res.json(await prisma.maintenanceOrder.findMany({ where: { machineId } }));
});

app.post("/maintenance-plans", async (req, res) => {
  const { machineId, frequencyDays, durationMin } = req.body;
  const plan = await prisma.maintenancePlan.create({ data: { machineId, frequencyDays, durationMin } });
  res.status(201).json(plan);
});

// Creating a maintenance order emits maintenance.orders.created (§14: 120s
// SLA trigger for Scheduling Svc to create a BLOCKED reservation and
// reschedule any overlapping work, per §7's Preventive Maintenance
// constraint's ±2-day flex band).
//
// Stage 01 HIGH-risk debt closure: the MaintenanceOrder below already
// committed before publication is attempted. A publish failure must not be
// reported as if the order itself was never created (it was) — but it is
// a real, consequential gap (scheduling-service's BLOCKED reservation for
// this maintenance window never gets created, risking a double-booked
// machine), so it's logged loudly and surfaced on the response, not
// swallowed.
app.post("/maintenance-orders", async (req, res) => {
  const { machineId, planId, type, scheduledStart, scheduledEnd, priority } = req.body;
  const order = await prisma.maintenanceOrder.create({
    data: {
      machineId,
      planId,
      type,
      scheduledStart: new Date(scheduledStart),
      scheduledEnd: new Date(scheduledEnd),
      priority,
    },
  });
  const syncError = await publishTracked(
    TOPICS.MAINTENANCE_ORDERS_CREATED,
    { maintenanceOrderId: order.id, machineId },
    { operation: "POST /maintenance-orders", entityId: order.id }
  );
  if (syncError) {
    logger.error("Downstream sync failed after commit — scheduling-service will NOT create a BLOCKED reservation for this maintenance window", {
      operation: syncError.operation,
      target: syncError.target,
      entityId: syncError.entityId,
      cause: String(syncError.cause),
    });
    res.status(201).json({ ...order, syncWarning: syncError.message });
    return;
  }
  res.status(201).json(order);
});

registerErrorHandler(app);
