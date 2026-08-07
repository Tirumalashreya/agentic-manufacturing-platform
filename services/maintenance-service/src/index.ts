process.env.SERVICE_NAME = "maintenance-service";

import { createApp, registerErrorHandler, logger, publish, TOPICS } from "@aps/shared";
import { prisma } from "@aps/domain";

const app = createApp();
const PORT = Number(process.env.PORT ?? 4012);

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
  await publish(TOPICS.MAINTENANCE_ORDERS_CREATED, { maintenanceOrderId: order.id, machineId });
  res.status(201).json(order);
});

registerErrorHandler(app);

app.listen(PORT, () => {
  logger.info(`maintenance-service listening on :${PORT}`);
});
