process.env.SERVICE_NAME = "inventory-service";

import { createApp, registerErrorHandler, logger, publish, publishTracked, TOPICS, requireIdentity } from "@aps/shared";
import { prisma, checkMaterialAvailability } from "@aps/domain";

// Split out of index.ts (Stage 01 HIGH-risk debt closure — same pattern as
// order-service/machine-service/maintenance-service) so vitest+supertest
// can exercise this app without binding the real port or starting the
// real Kafka consumer below (moved to index.ts).
export const app = createApp();

// §11: "Inventory Service — Stock levels, reservations, projected
// availability, shortage alerts — inventory.shortage.*"

// Stage 02 (Tenant Isolation + Service Identity): mounted only on these two
// routes, not globally — /vendors, /purchase-orders, /scan-shortages, and
// /inventory/movements are deliberately NOT tenant-scoped this stage (see
// the Stage 02 report's own "not migrated this stage" list); scoping them
// would mean tenant-scoping Vendor/PurchaseOrder too, which is real,
// separate scope this change doesn't take on.
const requireInventoryIdentity = requireIdentity("aps-internal");

// Stage 02: scoped by the caller's own enterprise — without this, any
// caller could read another enterprise's stock levels for a known
// productId.
app.get("/inventory", requireInventoryIdentity, async (req, res) => {
  const { productId } = req.query as { productId?: string };
  const records = await prisma.inventory.findMany({ where: { productId, enterpriseId: req.identity!.enterpriseId } });
  res.json(records);
});

// Stage 02: enterpriseId comes only from req.identity, and — found while
// writing this stage's own cross-tenant test, not assumed safe — the
// upsert's own WHERE now includes it too. productId alone is not yet
// tenant-split (Product itself isn't migrated this stage), so without
// enterpriseId in this key, a second enterprise's upsert for "the same"
// productId+location would silently overwrite the first enterprise's
// row instead of creating its own (see the schema's own comment on
// Inventory's unique index).
app.post("/inventory", requireInventoryIdentity, async (req, res) => {
  const { productId, location, qtyUnrestricted, qtyReserved, qtyInTransit } = req.body;
  const record = await prisma.inventory.upsert({
    where: { enterpriseId_productId_location: { enterpriseId: req.identity!.enterpriseId, productId, location } },
    create: { productId, location, qtyUnrestricted, qtyReserved, qtyInTransit, enterpriseId: req.identity!.enterpriseId },
    update: { qtyUnrestricted, qtyReserved, qtyInTransit },
  });
  res.status(201).json(record);
});

// Stage 06 (Service Ownership): the real Goods Issue write mes-integration
// used to make directly against this service's own Inventory/
// InventoryMovement tables (prisma.inventory.upsert/prisma.inventoryMovement.create,
// bypassing inventory-service's HTTP API entirely) — the one confirmed
// cross-domain write found in the Stage 06 service inventory. Same
// read-then-clamp-then-write shape mes-integration's own version already
// had (never go negative — scheduling already gated on availability at
// planning time, but real stock can genuinely have moved since); moved
// here unchanged so inventory-service becomes the one real writer of its
// own tables, and the resulting domain event is published from the same
// place the write actually happens, not from the caller.
app.post("/inventory/goods-issue", requireInventoryIdentity, async (req, res) => {
  const { productId, location, quantity, productionOrderId } = req.body as {
    productId: string;
    location: string;
    quantity: number;
    productionOrderId: string;
  };
  const enterpriseId = req.identity!.enterpriseId;
  const existing = await prisma.inventory.findUnique({
    where: { enterpriseId_productId_location: { enterpriseId, productId, location } },
  });
  const newQty = Math.max((existing?.qtyUnrestricted ?? 0) - quantity, 0);
  await prisma.inventory.upsert({
    where: { enterpriseId_productId_location: { enterpriseId, productId, location } },
    create: { productId, location, qtyUnrestricted: newQty, qtyReserved: 0, qtyInTransit: 0, enterpriseId },
    update: { qtyUnrestricted: newQty },
  });
  const movement = await prisma.inventoryMovement.create({
    data: { type: "GOODS_ISSUE", productId, location, quantity, productionOrderId },
  });
  await publish(TOPICS.INVENTORY_MOVEMENT_RECORDED, {
    movementId: movement.id,
    type: movement.type,
    productId: movement.productId,
    location: movement.location,
    quantity: movement.quantity,
    productionOrderId,
  });
  res.status(201).json(movement);
});

// Checks one product's BOM components against stock, publishing
// inventory.shortage.detected (§14: 180s SLA trigger for Scheduling Svc to
// push the affected op's start to the Material Availability Date, per §7's
// Material Availability constraint) for anything short. Shared by the
// on-demand HTTP scan below and the orders.production.created consumer.
//
// Not touched by the Stage 01 HIGH-risk debt closure: this function makes
// no DB write of its own (every call here is a read), so a publish
// failure here can't misrepresent a committed write as failed — a
// different, lower-risk shape than the 4 named HIGH-risk paths. Left as
// plain publish(), unchanged, matching the instruction to close only the
// named debt, not every remaining site.
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
//
// Stage 01 HIGH-risk debt closure: the $transaction (purchaseOrder.update
// + inventoryMovement.create) and the separate inventory.upsert below are
// left exactly as-is, per the explicit instruction not to redesign the
// transaction structure — fixing publish-failure semantics doesn't
// require touching either. By the time publication is attempted, all 3
// writes have already committed; a publish failure must not be reported
// as if the receipt itself failed (the endpoint's own existing
// idempotency guard above — `409 "already received"` — already means a
// naive retry can't double-process regardless, so this isn't introducing
// a new duplicate-receipt risk).
// Stage 02: this route is NOT otherwise tenant-scoped this stage (PurchaseOrder
// itself isn't migrated — see the Stage 02 report) — requireIdentity is
// mounted here ONLY because the Inventory row below is tenant-owned and the
// schema now requires a real enterpriseId on every row, not to authorize
// the PurchaseOrder lookup itself.
app.post("/purchase-orders/:id/receive", requireInventoryIdentity, async (req, res) => {
  const { location } = req.body as { location?: string };
  if (!location) {
    res.status(400).json({ error: "location is required" });
    return;
  }
  const po = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id as string } });
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
    where: { enterpriseId_productId_location: { enterpriseId: req.identity!.enterpriseId, productId: po.productSku, location } },
    create: {
      productId: po.productSku, location, qtyUnrestricted: po.quantity, qtyReserved: 0, qtyInTransit: 0,
      enterpriseId: req.identity!.enterpriseId,
    },
    update: { qtyUnrestricted: { increment: po.quantity } },
  });

  const syncError = await publishTracked(
    TOPICS.INVENTORY_MOVEMENT_RECORDED,
    {
      movementId: movement.id,
      type: movement.type,
      productId: movement.productId,
      location: movement.location,
      quantity: movement.quantity,
      purchaseOrderId: po.id,
    },
    { operation: "POST /purchase-orders/:id/receive", entityId: movement.id }
  );
  if (syncError) {
    logger.error("Downstream sync failed after commit", {
      operation: syncError.operation,
      target: syncError.target,
      entityId: syncError.entityId,
      cause: String(syncError.cause),
    });
    res.status(201).json({ ...movement, syncWarning: syncError.message });
    return;
  }
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

// Exported for the Kafka consumer moved to index.ts (orders.production.created
// fan-out) — same function, not duplicated.
export { checkShortagesForProduct };
