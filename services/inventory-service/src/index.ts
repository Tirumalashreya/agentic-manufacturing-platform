import { logger, subscribe, ensureTopics, TOPICS } from "@aps/shared";
import { prisma } from "@aps/domain";
import { app, checkShortagesForProduct } from "./app";

const PORT = Number(process.env.PORT ?? 4010);

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
