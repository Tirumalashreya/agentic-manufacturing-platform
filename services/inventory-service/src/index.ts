process.env.SERVICE_NAME = "inventory-service";

import { createApp, registerErrorHandler, logger, publish, subscribe, ensureTopics, TOPICS } from "@aps/shared";
import { prisma, checkMaterialAvailability } from "@aps/domain";

const app = createApp();
const PORT = Number(process.env.PORT ?? 4010);

// §11: "Inventory Service — Stock levels, reservations, projected
// availability, shortage alerts — inventory.shortage.*"

app.get("/inventory", async (req, res) => {
  const { productId } = req.query as { productId?: string };
  const records = await prisma.inventory.findMany({ where: { productId } });
  res.json(records);
});

app.post("/inventory", async (req, res) => {
  const { productId, location, qtyUnrestricted, qtyReserved, qtyInTransit } = req.body;
  const record = await prisma.inventory.upsert({
    where: { productId_location: { productId, location } },
    create: { productId, location, qtyUnrestricted, qtyReserved, qtyInTransit },
    update: { qtyUnrestricted, qtyReserved, qtyInTransit },
  });
  res.status(201).json(record);
});

// Checks one product's BOM components against stock, publishing
// inventory.shortage.detected (§14: 180s SLA trigger for Scheduling Svc to
// push the affected op's start to the Material Availability Date, per §7's
// Material Availability constraint) for anything short. Shared by the
// on-demand HTTP scan below and the orders.production.created consumer.
async function checkShortagesForProduct(productId: string, requiredQty: number) {
  const shortages: { productId: string; required: number; available: number }[] = [];
  const bom = await prisma.bOM.findFirst({ where: { productId }, include: { lines: true } });
  if (!bom) return shortages;

  for (const line of bom.lines) {
    const inventory = await prisma.inventory.findMany({ where: { productId: line.componentId } });
    const stock = inventory.reduce((s, i) => s + i.qtyUnrestricted, 0);
    const reserved = inventory.reduce((s, i) => s + i.qtyReserved, 0);
    const inbound = await prisma.purchaseOrder.findMany({ where: { productSku: line.componentId, confirmed: true } });
    const confirmedInbound = inbound.reduce((s, po) => s + po.quantity, 0);
    const required = line.quantityPer * requiredQty;

    const result = checkMaterialAvailability({ stock, priorReservations: reserved, confirmedInbound, required });
    if (!result.feasible) {
      shortages.push({ productId: line.componentId, required, available: stock - reserved + confirmedInbound });
      await publish(TOPICS.INVENTORY_SHORTAGE_DETECTED, { productId: line.componentId, required, triggeringProductId: productId });
    }
  }
  return shortages;
}

app.post("/inventory/scan-shortages", async (_req, res) => {
  const openOrders = await prisma.productionOrder.findMany({ where: { status: { in: ["PLANNED", "RELEASED"] } } });
  const byProduct = new Map<string, number>();
  for (const o of openOrders) byProduct.set(o.productId, (byProduct.get(o.productId) ?? 0) + o.quantity);

  const shortages = [];
  for (const [productId, qty] of byProduct) {
    shortages.push(...(await checkShortagesForProduct(productId, qty)));
  }
  logger.info("Shortage scan complete", { shortageCount: shortages.length });
  res.json({ shortages });
});

registerErrorHandler(app);

app.listen(PORT, () => {
  logger.info(`inventory-service listening on :${PORT}`);
});

// §11 Key Kafka Topics: "orders.production.created → Routing Svc,
// Scheduling Svc, Inventory Svc" — this is inventory-service's half of that
// fan-out, proactively checking material availability the moment an order
// is created rather than waiting for someone to call the HTTP scan.
async function startConsumer() {
  await ensureTopics([TOPICS.ORDERS_PRODUCTION_CREATED, TOPICS.INVENTORY_SHORTAGE_DETECTED]);
  await subscribe("inventory-service", [TOPICS.ORDERS_PRODUCTION_CREATED], async (_topic, message) => {
    const { orderId, productId } = message as { orderId: string; productId: string };
    const order = await prisma.productionOrder.findUnique({ where: { id: orderId } });
    if (!order) return;
    const shortages = await checkShortagesForProduct(productId, order.quantity);
    logger.info("Reacted to orders.production.created", { orderId, productId, shortageCount: shortages.length });
  });
  logger.info("Subscribed to orders.production.created");
}

startConsumer().catch((error) => logger.error("Kafka consumer failed to start", { error: String(error) }));
