process.env.SERVICE_NAME = "order-service";

import { createApp, registerErrorHandler, logger, publish, TOPICS } from "@aps/shared";
import { prisma, computePriorityScore, type CustomerTier, type Prisma } from "@aps/domain";

const app = createApp();
const PORT = Number(process.env.PORT ?? 4001);

const REFERENCE_MAX_ORDER_VALUE = 100_000;
const REFERENCE_MAX_PENALTY_EXPOSURE = 5_000;
const PLANNING_HORIZON_DAYS = 91;

// §11: "Order Service — Production order CRUD, priority scoring, status
// lifecycle — Publishes orders.production.*"

// No service previously exposed Customer creation — every Customer in this
// codebase's history was created via direct Prisma access in ad-hoc scripts.
app.post("/customers", async (req, res) => {
  const { name, tier, slaDays, penaltyPerDay } = req.body;
  const customer = await prisma.customer.create({ data: { name, tier, slaDays, penaltyPerDay } });
  res.status(201).json(customer);
});

app.post("/sales-orders", async (req, res) => {
  const { customerId, dueDate, value, priority } = req.body;
  const salesOrder = await prisma.salesOrder.create({ data: { customerId, dueDate: new Date(dueDate), value, priority } });
  res.status(201).json(salesOrder);
});

app.get("/orders", async (req, res) => {
  const { plantId, status } = req.query as { plantId?: string; status?: string };
  const orders = await prisma.productionOrder.findMany({
    where: { plantId, status: status as never },
    include: { salesOrder: { include: { customer: true } }, product: true },
    orderBy: { priorityScore: "desc" },
  });
  res.json(orders);
});

app.get("/orders/:id", async (req, res) => {
  const order = await prisma.productionOrder.findUnique({
    where: { id: req.params.id },
    include: { salesOrder: { include: { customer: true } }, product: true, scheduledOperations: true },
  });
  if (!order) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  res.json(order);
});

// §13 step "Order Intake": BOM exploded, routing resolved, priority scored,
// order persisted — the explosion/routing-resolution part is a lookup
// (routing-service owns creating the actual Routing/BOM records; this just
// links an order to an already-defined one), priority scoring happens here.
app.post("/orders", async (req, res) => {
  const { plantId, salesOrderId, productId, routingId, bomId, quantity, manualOverride, metadata } = req.body as {
    plantId: string;
    salesOrderId?: string;
    productId: string;
    routingId?: string;
    bomId?: string;
    quantity: number;
    manualOverride?: number;
    metadata?: Prisma.InputJsonValue;
  };

  let priorityScore = manualOverride ?? 0;
  if (salesOrderId) {
    const salesOrder = await prisma.salesOrder.findUnique({ where: { id: salesOrderId }, include: { customer: true } });
    if (salesOrder) {
      priorityScore = computePriorityScore({
        customerTier: salesOrder.customer.tier as CustomerTier,
        dueDate: salesOrder.dueDate,
        now: new Date(),
        planningHorizonDays: PLANNING_HORIZON_DAYS,
        orderValue: salesOrder.value,
        referenceMaxOrderValue: REFERENCE_MAX_ORDER_VALUE,
        penaltyPerDay: salesOrder.customer.penaltyPerDay,
        slaDays: salesOrder.customer.slaDays,
        referenceMaxPenaltyExposure: REFERENCE_MAX_PENALTY_EXPOSURE,
        manualOverride,
      });
    }
  }

  const order = await prisma.productionOrder.create({
    data: { plantId, salesOrderId, productId, routingId, bomId, quantity, priorityScore, status: "PLANNED", metadata },
  });

  await publish(TOPICS.ORDERS_PRODUCTION_CREATED, { orderId: order.id, plantId, productId, priorityScore });
  logger.info("Production order created", { orderId: order.id, priorityScore });
  res.status(201).json(order);
});

app.patch("/orders/:id", async (req, res) => {
  const { status, quantity } = req.body as { status?: string; quantity?: number };
  const order = await prisma.productionOrder.update({
    where: { id: req.params.id },
    data: { status: status as never, quantity },
  });
  // plantId + quantityChanged let a rescheduling consumer (§14 Order
  // Cancellation / Order Qty Change) act only on genuine disruptions —
  // quantity !== undefined is checked here, at the point where we still
  // know whether THIS request touched quantity, not just its current
  // value, which a routine status-only update (e.g. RELEASED->IN_PROGRESS)
  // would otherwise be indistinguishable from.
  await publish(TOPICS.ORDERS_PRODUCTION_UPDATED, {
    orderId: order.id,
    plantId: order.plantId,
    status: order.status,
    quantityChanged: quantity !== undefined,
  });
  res.json(order);
});

// Hard delete — unlike PATCH .../status=CANCELLED (a soft cancel that keeps
// the order for schedule history), this actually removes the order and
// everything scheduled against it. Torn down in FK-safe order: reservations
// before their scheduled operations (ResourceReservation has no cascade on
// scheduledOperationId), scheduled operations before the order (Prisma's
// own onDelete: Cascade would handle this step alone, but reservations
// would still block it if left in place), then any dependency edges to/from
// this order, then the order itself. The paired SalesOrder is left alone —
// it may not be exclusively this order's (SalesOrder -> ProductionOrder is
// one-to-many in the schema) and deleting it isn't required for a clean
// delete of this order.
app.delete("/orders/:id", async (req, res) => {
  const orderId = req.params.id;
  const scheduledOps = await prisma.scheduledOperation.findMany({ where: { productionOrderId: orderId }, select: { id: true } });
  const opIds = scheduledOps.map((o) => o.id);

  await prisma.resourceReservation.deleteMany({ where: { scheduledOperationId: { in: opIds } } });
  await prisma.scheduledOperation.deleteMany({ where: { id: { in: opIds } } });
  await prisma.productionOrderDependency.deleteMany({ where: { OR: [{ parentId: orderId }, { childId: orderId }] } });
  await prisma.productionOrder.delete({ where: { id: orderId } });

  logger.info("Production order deleted", { orderId, scheduledOpsRemoved: opIds.length });
  res.status(204).end();
});

registerErrorHandler(app);

app.listen(PORT, () => {
  logger.info(`order-service listening on :${PORT}`);
});
