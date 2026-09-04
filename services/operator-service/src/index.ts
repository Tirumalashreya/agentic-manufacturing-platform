process.env.SERVICE_NAME = "operator-service";

import { createApp, registerErrorHandler, logger } from "@aps/shared";
import { prisma } from "@aps/domain";

const app = createApp();
const PORT = Number(process.env.PORT ?? 4009);

// §11: "Operator Service — Operator records, shift assignments, skill
// management — GET /operators/available"

app.get("/operators", async (_req, res) => {
  const operators = await prisma.operator.findMany({ include: { skills: { include: { skill: true } }, shifts: { include: { shift: true } } } });
  res.json(operators);
});

// No service previously exposed Skill creation at all — needed so a
// planner can define skills (e.g. "CNC Operation", "Welding") before
// assigning them to operators or requiring them on a routing operation.
app.get("/skills", async (_req, res) => {
  res.json(await prisma.skill.findMany());
});

app.post("/skills", async (req, res) => {
  const { name } = req.body as { name: string };
  const skill = await prisma.skill.create({ data: { name } });
  res.status(201).json(skill);
});

app.post("/operators", async (req, res) => {
  const { employeeId, name, department, employmentType } = req.body;
  const operator = await prisma.operator.create({ data: { employeeId, name, department, employmentType } });
  res.status(201).json(operator);
});

// Links an operator to an existing Shift (created via calendar-service's
// POST /shifts) — same pattern as machine-service's POST
// /machines/:id/capabilities. Needed so an operator actually has working
// hours the scheduling pipeline's operator-availability check can consult;
// previously there was no way to create this link at all.
app.post("/operators/:id/shifts", async (req, res) => {
  const { shiftId } = req.body as { shiftId: string };
  const record = await prisma.operatorShift.create({
    data: { operatorId: req.params.id, shiftId },
  });
  res.status(201).json(record);
});

app.post("/operators/:id/skills", async (req, res) => {
  const { skillId, proficiency, certifiedUntil } = req.body as { skillId: string; proficiency: string; certifiedUntil?: string };
  const record = await prisma.operatorSkill.create({
    data: {
      operatorId: req.params.id,
      skillId,
      proficiency,
      certifiedUntil: certifiedUntil ? new Date(certifiedUntil) : null,
    },
  });
  res.status(201).json(record);
});

// The doc's one explicitly named endpoint for this service: qualified
// (holds `skillId` at >= minProficiency, cert not expired) AND not already
// reserved over [start, end) via ResourceReservation.
app.get("/operators/available", async (req, res) => {
  const { skillId, minProficiency, start, end } = req.query as {
    skillId?: string;
    minProficiency?: string;
    start?: string;
    end?: string;
  };
  if (!start || !end) {
    res.status(400).json({ error: "start and end query params are required" });
    return;
  }
  const rank: Record<string, number> = { TRAINEE: 0, STANDARD: 1, EXPERT: 2 };
  const minRank = rank[minProficiency ?? "TRAINEE"] ?? 0;

  const candidates = await prisma.operator.findMany({
    where: skillId ? { skills: { some: { skillId } } } : {},
    include: { skills: true, reservations: true },
  });

  const now = new Date();
  const startDate = new Date(start);
  const endDate = new Date(end);

  const available = candidates.filter((op) => {
    if (skillId) {
      const skillMatch = op.skills.find((s) => s.skillId === skillId);
      if (!skillMatch) return false;
      if (rank[skillMatch.proficiency] < minRank) return false;
      if (skillMatch.certifiedUntil && skillMatch.certifiedUntil < now) return false;
    }
    const conflicting = op.reservations.some(
      (r) => r.state === "COMMITTED" && r.startTime < endDate && startDate < r.endTime
    );
    return !conflicting;
  });

  res.json(available.map((op) => ({ id: op.id, employeeId: op.employeeId, name: op.name })));
});

// Hard delete — unlike a machine or order, deleting an operator shouldn't
// delete the real scheduled work they were on; those ScheduledOperation
// rows are unassigned (operatorId -> null, reverting to machine-only,
// exactly the state they'd be in if no operator had ever qualified for
// that slot) rather than removed. OperatorSkill/OperatorShift cascade on
// the Operator relation already (schema.prisma); ResourceReservation does
// not, so it's cleared explicitly first.
app.delete("/operators/:id", async (req, res) => {
  const operatorId = req.params.id;
  await prisma.resourceReservation.deleteMany({ where: { operatorId } });
  await prisma.scheduledOperation.updateMany({ where: { operatorId }, data: { operatorId: null } });
  await prisma.operator.delete({ where: { id: operatorId } });
  logger.info("Operator deleted", { operatorId });
  res.status(204).end();
});

registerErrorHandler(app);

app.listen(PORT, () => {
  logger.info(`operator-service listening on :${PORT}`);
});
