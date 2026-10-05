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
    // receivedAt: null — a received PO's quantity is now real stock
    // (qtyUnrestricted, via POST /purchase-orders/:id/receive below), so
    // counting it here too would double-count it. Real fix enabled by
    // Phase 3's receivedAt field.
    const inbound = await prisma.purchaseOrder.findMany({ where: { productSku: line.componentId, confirmed: true, receivedAt: null } });
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

// No service previously exposed Vendor/PurchaseOrder creation — the
// Prisma models existed (see checkShortagesForProduct's own read of
// PurchaseOrder above) but nothing ever wrote to them. Added for the
// Production Planning Agent's shortage-remediation suggestion: when a
// real MATERIAL_SHORTAGE is found, it needs somewhere to actually place a
// purchase order for the missing quantity, not just report the gap.
// inventory-service is the natural owner — it's already the service that
// reads PurchaseOrder to net confirmed inbound quantity against shortages.
app.post("/vendors", async (req, res) => {
  const { name, leadTimeDays, reliabilityScore } = req.body as { name: string; leadTimeDays?: number; reliabilityScore?: number };
  const vendor = await prisma.vendor.create({ data: { name, leadTimeDays, reliabilityScore } });
  res.status(201).json(vendor);
});

// Real per-component vendor data (Phase 7, agreed with the user) — when
// productId is given, returns only vendors real-linked to that specific
// component via VendorProduct, sorted by the PER-COMPONENT leadTimeDays
// (not the vendor's own global default), with unitCost included. Omitting
// productId preserves the exact previous behavior (the global list,
// Vendor.leadTimeDays) unchanged — this is what a caller falls back to
// when a component has no real per-component vendor data configured yet.
app.get("/vendors", async (req, res) => {
  const { productId } = req.query as { productId?: string };
  if (productId) {
    const links = await prisma.vendorProduct.findMany({
      where: { productId },
      orderBy: { leadTimeDays: "asc" },
      include: { vendor: { select: { id: true, name: true, reliabilityScore: true } } },
    });
    res.json(
      links.map((l) => ({
        id: l.vendor.id,
        name: l.vendor.name,
        reliabilityScore: l.vendor.reliabilityScore,
        leadTimeDays: l.leadTimeDays,
        unitCost: l.unitCost,
      }))
    );
    return;
  }
  const vendors = await prisma.vendor.findMany({ orderBy: { leadTimeDays: "asc" } });
  res.json(vendors);
});

// Real data-entry for VendorProduct (Phase 7) — without this route, the
// new model would be exactly the kind of orphaned schema ChangeoverMatrix
// was before Phase 3 gave Materials a real way to populate data.
app.post("/vendors/:id/products", async (req, res) => {
  const { productId, leadTimeDays, unitCost } = req.body as { productId?: string; leadTimeDays?: number; unitCost?: number };
  if (!productId || leadTimeDays == null || unitCost == null) {
    res.status(400).json({ error: "productId, leadTimeDays, and unitCost are required" });
    return;
  }
  try {
    const link = await prisma.vendorProduct.upsert({
      where: { vendorId_productId: { vendorId: req.params.id, productId } },
      create: { vendorId: req.params.id, productId, leadTimeDays, unitCost },
      update: { leadTimeDays, unitCost },
    });
    res.status(201).json(link);
  } catch (error) {
    logger.error("Vendor-product link failed", { vendorId: req.params.id, productId, error: String(error) });
    res.status(404).json({ error: "Vendor or product not found" });
  }
});

// productSku here is deliberately the component Product's id (a cuid),
// matching checkShortagesForProduct's own existing (if oddly-named)
// convention above (`productSku: line.componentId`) — not a real SKU
// string. Kept consistent with what already reads this field rather than
// "fixing" the naming as a side effect of this change.
app.post("/purchase-orders", async (req, res) => {
  const { vendorId, productSku, quantity, expectedDate, confirmed } = req.body as {
    vendorId: string;
    productSku: string;
    quantity: number;
    expectedDate: string;
    confirmed?: boolean;
  };
  const po = await prisma.purchaseOrder.create({
    data: { vendorId, productSku, quantity, expectedDate: new Date(expectedDate), confirmed: confirmed ?? true },
  });
  res.status(201).json(po);
});

// Real read for the new Materials page — no route previously listed
// PurchaseOrders at all (only creation existed). productSku is really the
// component Product's id (see the create route's own comment above) —
// joined here so the UI shows a real sku, not a raw cuid.
app.get("/purchase-orders", async (_req, res) => {
  const orders = await prisma.purchaseOrder.findMany({
    orderBy: { expectedDate: "asc" },
    include: { vendor: { select: { name: true } } },
  });
  const productIds = [...new Set(orders.map((o) => o.productSku))];
  const products = await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, sku: true } });
  const skuById = new Map(products.map((p) => [p.id, p.sku]));
  res.json(
    orders.map((o) => ({
      id: o.id,
      vendorName: o.vendor.name,
      productSku: skuById.get(o.productSku) ?? o.productSku,
      quantity: o.quantity,
      expectedDate: o.expectedDate,
      confirmed: o.confirmed,
      receivedAt: o.receivedAt,
    }))
  );
});

// Real Goods Receipt (Phase 3, agreed with the user) — closes a
// PurchaseOrder into real stock. MVP is full-receipt only: one PO, one
// receipt, for its whole quantity — no partial-quantity tracking this
// round (see receivedAt's own doc comment on the schema).
app.post("/purchase-orders/:id/receive", async (req, res) => {
  const { location } = req.body as { location?: string };
  if (!location) {
    res.status(400).json({ error: "location is required" });
    return;
  }
  const po = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id } });
  if (!po) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }
  if (po.receivedAt) {
    res.status(409).json({ error: "Purchase order already received" });
    return;
  }

  const [, movement] = await prisma.$transaction([
    prisma.purchaseOrder.update({ where: { id: po.id }, data: { receivedAt: new Date() } }),
    prisma.inventoryMovement.create({
      data: { type: "GOODS_RECEIPT", productId: po.productSku, location, quantity: po.quantity, purchaseOrderId: po.id },
    }),
  ]);
  await prisma.inventory.upsert({
    where: { productId_location: { productId: po.productSku, location } },
    create: { productId: po.productSku, location, qtyUnrestricted: po.quantity, qtyReserved: 0, qtyInTransit: 0 },
    update: { qtyUnrestricted: { increment: po.quantity } },
  });

  await publish(TOPICS.INVENTORY_MOVEMENT_RECORDED, {
    movementId: movement.id,
    type: movement.type,
    productId: movement.productId,
    location: movement.location,
    quantity: movement.quantity,
    purchaseOrderId: po.id,
  });
  res.status(201).json(movement);
});

// Real, read-only recent movement log for the new Materials page — same
// shape as scheduling-service's GET .../exceptions route (Phase 1).
app.get("/inventory/movements", async (req, res) => {
  const { location } = req.query as { location?: string };
  const movements = await prisma.inventoryMovement.findMany({
    where: location ? { location } : undefined,
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { product: { select: { sku: true } } },
  });
  res.json({
    items: movements.map((m) => ({
      id: m.id,
      type: m.type,
      productSku: m.product.sku,
      location: m.location,
      quantity: m.quantity,
      purchaseOrderId: m.purchaseOrderId,
      productionOrderId: m.productionOrderId,
      createdAt: m.createdAt,
    })),
  });
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
