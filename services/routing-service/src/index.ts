process.env.SERVICE_NAME = "routing-service";

import { createApp, registerErrorHandler, logger } from "@aps/shared";
import { prisma, Prisma } from "@aps/domain";

const app = createApp();
const PORT = Number(process.env.PORT ?? 4002);

// §11: "Routing Service — Routing + BOM master data, routing resolution —
// GET /routings/resolve"

app.post("/products", async (req, res) => {
  const { sku, family, uom, lotSizeMin, lotSizeMax, leadTimeDays, batchManaged, defaultSchedulingMode, metadata } = req.body as {
    sku: string;
    family: string;
    uom: string;
    lotSizeMin?: number;
    lotSizeMax?: number;
    leadTimeDays?: number;
    batchManaged?: boolean;
    defaultSchedulingMode?: string;
    metadata?: Prisma.InputJsonValue;
  };
  const product = await prisma.product.create({
    data: { sku, family, uom, lotSizeMin, lotSizeMax, leadTimeDays, batchManaged, defaultSchedulingMode, metadata },
  });
  res.status(201).json(product);
});

app.post("/boms", async (req, res) => {
  const { productId, version, lotSize } = req.body;
  const bom = await prisma.bOM.create({ data: { productId, version, lotSize } });
  res.status(201).json(bom);
});

app.post("/boms/:id/lines", async (req, res) => {
  const { componentId, quantityPer } = req.body;
  const line = await prisma.bOMLine.create({ data: { bomId: req.params.id, componentId, quantityPer } });
  res.status(201).json(line);
});

app.post("/routings", async (req, res) => {
  const { productId, version } = req.body;
  const routing = await prisma.routing.create({ data: { productId, version } });
  res.status(201).json(routing);
});

app.post("/routings/:id/operations", async (req, res) => {
  const {
    opNumber,
    operation,
    workCenterId,
    processingTimeMin,
    setupTimeMin,
    requiresInspection,
    overlapPct,
    alternativeWorkCenterIds,
  } = req.body;
  const op = await prisma.routingOperation.create({
    data: {
      routingId: req.params.id,
      opNumber,
      operation,
      workCenterId,
      processingTimeMin,
      setupTimeMin,
      requiresInspection,
      overlapPct,
      alternativeWorkCenterIds,
    },
  });
  res.status(201).json(op);
});

app.post("/operations/:id/predecessors", async (req, res) => {
  const { predecessorId } = req.body as { predecessorId: string };
  const dep = await prisma.routingOpDependency.create({
    data: { predecessorId, successorId: req.params.id },
  });
  res.status(201).json(dep);
});

// The doc's named endpoint: the active routing for a product, with its
// full operation DAG (predecessors included) — what scheduling-service's
// §6 step 4 (Routing) consumes.
app.get("/routings/resolve", async (req, res) => {
  const { productId } = req.query as { productId?: string };
  if (!productId) {
    res.status(400).json({ error: "productId is required" });
    return;
  }
  const routing = await prisma.routing.findFirst({
    where: { productId, OR: [{ validTo: null }, { validTo: { gte: new Date() } }] },
    orderBy: { validFrom: "desc" },
    include: {
      operations: {
        include: { predecessors: true, workCenter: true },
        orderBy: { opNumber: "asc" },
      },
    },
  });
  if (!routing) {
    res.status(404).json({ error: "No active routing found for this product" });
    return;
  }
  res.json(routing);
});

// The BOM counterpart to /routings/resolve above — same active-version
// resolution pattern, added for the Production Planning Agent (agent-
// orchestrator) to get a real per-component materials breakdown for one
// order. Previously the only way to touch BOM data via HTTP was inventory-
// service's /inventory/scan-shortages, which scans every open order in a
// plant at once and returns only components that are short (no PASS
// lines) — not precise enough for a single order's honest breakdown. This
// is purely additive: a new read endpoint, no existing behavior changed.
app.get("/boms/resolve", async (req, res) => {
  const { productId } = req.query as { productId?: string };
  if (!productId) {
    res.status(400).json({ error: "productId is required" });
    return;
  }
  const bom = await prisma.bOM.findFirst({
    where: { productId, OR: [{ validTo: null }, { validTo: { gte: new Date() } }] },
    orderBy: { validFrom: "desc" },
    include: { lines: { include: { component: true } } },
  });
  if (!bom) {
    res.status(404).json({ error: "No active BOM found for this product" });
    return;
  }
  res.json(bom);
});

registerErrorHandler(app);

app.listen(PORT, () => {
  logger.info(`routing-service listening on :${PORT}`);
});
