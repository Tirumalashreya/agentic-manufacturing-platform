process.env.SERVICE_NAME = "tool-service";

import { createApp, registerErrorHandler, logger } from "@aps/shared";
import { prisma, checkToolAvailability } from "@aps/domain";

const app = createApp();
const PORT = Number(process.env.PORT ?? 4011);

// §11: "Tool Service — Tool inventory, availability, life tracking,
// reservations — GET /tools/available"

app.get("/tools", async (_req, res) => {
  res.json(await prisma.tool.findMany());
});

app.post("/tools", async (req, res) => {
  const { type, remainingLifePct, location } = req.body;
  const tool = await prisma.tool.create({ data: { type, remainingLifePct, location } });
  res.status(201).json(tool);
});

// The doc's named endpoint: tools of `type` currently AVAILABLE, with
// remaining life at/above the caller's minimum, in the quantity requested
// — reuses the Constraint Engine's Tool Availability check (§7) directly
// rather than re-deriving the same logic here.
app.get("/tools/available", async (req, res) => {
  const { type, requiredQty, minRequiredLifePct } = req.query as {
    type?: string;
    requiredQty?: string;
    minRequiredLifePct?: string;
  };
  const candidates = await prisma.tool.findMany({ where: { type, status: "AVAILABLE" } });
  const result = checkToolAvailability({
    availableQty: candidates.length,
    requiredQty: Number(requiredQty ?? 1),
    remainingLifePct: Math.min(...candidates.map((t) => t.remainingLifePct), 100),
    minRequiredLifePct: Number(minRequiredLifePct ?? 0),
  });
  res.json({ feasible: result.feasible, tools: candidates });
});

app.post("/tools/:id/reserve", async (req, res) => {
  const { scheduledOperationId, quantity } = req.body as { scheduledOperationId: string; quantity?: number };
  const usage = await prisma.toolUsage.create({
    data: { toolId: req.params.id, scheduledOperationId, quantity: quantity ?? 1 },
  });
  await prisma.tool.update({ where: { id: req.params.id }, data: { status: "IN_USE" } });
  res.status(201).json(usage);
});

registerErrorHandler(app);

app.listen(PORT, () => {
  logger.info(`tool-service listening on :${PORT}`);
});
