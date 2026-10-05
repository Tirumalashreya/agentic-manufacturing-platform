process.env.SERVICE_NAME = "machine-service";

import { createApp, registerErrorHandler, logger, publish, subscribe, ensureTopics, TOPICS } from "@aps/shared";
import { prisma, Prisma } from "@aps/domain";

const app = createApp();
const PORT = Number(process.env.PORT ?? 4008);

// §11: "Machine Service — Machine master data, real-time status,
// capability, breakdown reporting — machines.status.* · machines.breakdown.*"

// No service previously exposed WorkCenter creation — every WorkCenter in
// this codebase's history was created via direct Prisma access in ad-hoc
// scripts. This is the real endpoint the bulk setup importer (and anything
// else) should use instead.
app.post("/work-centers", async (req, res) => {
  const { plantId, code, type, efficiencyFactor, workingDaysOfWeek, holidayCalendarId } = req.body;
  const workCenter = await prisma.workCenter.create({
    data: { plantId, code, type, efficiencyFactor, workingDaysOfWeek, holidayCalendarId },
  });
  res.status(201).json(workCenter);
});

// No service previously exposed listing WorkCenters either — the setup
// importer and every ad-hoc script only ever created them. Needed now so
// the Calendar page can list a plant's work centers to set a per-work-
// center calendar override on.
app.get("/work-centers", async (req, res) => {
  const { plantId } = req.query as { plantId?: string };
  const workCenters = await prisma.workCenter.findMany({
    where: plantId ? { plantId } : undefined,
    orderBy: { code: "asc" },
  });
  res.json(workCenters);
});

// Real SAP-style multi-level Factory Calendar assignment (§ calendar
// architecture): a work center can override the plant's default
// holiday/working-day pattern. Both fields optional in the body — passing
// only one leaves the other untouched. `holidayCalendarId: null` explicitly
// clears the override back to "inherit from plant".
app.patch("/work-centers/:id/calendar", async (req, res) => {
  const { workingDaysOfWeek, holidayCalendarId } = req.body as {
    workingDaysOfWeek?: number[];
    holidayCalendarId?: string | null;
  };
  const workCenter = await prisma.workCenter.update({
    where: { id: req.params.id },
    data: { workingDaysOfWeek, holidayCalendarId },
  });
  res.json(workCenter);
});

app.get("/machines", async (req, res) => {
  const { workCenterId, plantId } = req.query as { workCenterId?: string; plantId?: string };
  const machines = await prisma.machine.findMany({
    where: {
      workCenterId,
      ...(plantId ? { workCenter: { plantId } } : {}),
    },
    include: { capabilities: true },
  });
  res.json(machines);
});

app.get("/machines/:id", async (req, res) => {
  const machine = await prisma.machine.findUnique({ where: { id: req.params.id }, include: { capabilities: true } });
  if (!machine) {
    res.status(404).json({ error: "Machine not found" });
    return;
  }
  res.json(machine);
});

app.post("/machines", async (req, res) => {
  const { workCenterId, name, type, ratedCapacity, minBatch, maxBatch, setupTimeMin, powerKw, status, metadata } = req.body as {
    workCenterId: string;
    name: string;
    type: string;
    ratedCapacity: number;
    minBatch?: number;
    maxBatch?: number;
    setupTimeMin?: number;
    powerKw?: number;
    status?: "AVAILABLE" | "RUNNING" | "DOWN" | "MAINTENANCE" | "OFFLINE";
    metadata?: Prisma.InputJsonValue;
  };
  const machine = await prisma.machine.create({
    data: { workCenterId, name, type, ratedCapacity, minBatch, maxBatch, setupTimeMin, powerKw, status, metadata },
  });
  res.status(201).json(machine);
});

app.post("/machines/:id/capabilities", async (req, res) => {
  const { operationType, spec } = req.body as { operationType: string; spec?: Prisma.InputJsonValue };
  const capability = await prisma.machineCapability.create({
    data: { machineId: req.params.id, operationType, spec: spec ?? undefined },
  });
  res.status(201).json(capability);
});

// Status change → machines.status.changed (consumed by Reporting Svc per §11)
app.patch("/machines/:id/status", async (req, res) => {
  const { status } = req.body as { status: "AVAILABLE" | "RUNNING" | "DOWN" | "MAINTENANCE" | "OFFLINE" };
  const machine = await prisma.machine.update({ where: { id: req.params.id }, data: { status } });
  await publish(TOPICS.MACHINES_STATUS_CHANGED, { machineId: machine.id, status });
  res.json(machine);
});

// Breakdown report → creates a MachineEvent, forces status DOWN, and emits
// machines.breakdown.reported (§14: 60s SLA trigger for Scheduling Svc /
// Maintenance Svc / Notification to react to).
app.post("/machines/:id/breakdown", async (req, res) => {
  const { faultCode, durationMinutes } = req.body as { faultCode?: string; durationMinutes?: number };
  const [event, machine] = await Promise.all([
    prisma.machineEvent.create({
      data: { machineId: req.params.id, eventType: "BREAKDOWN", faultCode, durationMinutes },
    }),
    prisma.machine.update({ where: { id: req.params.id }, data: { status: "DOWN" } }),
  ]);
  await publish(TOPICS.MACHINES_BREAKDOWN_REPORTED, { machineId: machine.id, faultCode, eventId: event.id });
  logger.info("Machine breakdown reported", { machineId: machine.id, faultCode });
  res.status(201).json(event);
});

registerErrorHandler(app);

app.listen(PORT, () => {
  logger.info(`machine-service listening on :${PORT}`);
});

// §11: machines.sensors.* is produced by IoT Ingestion; Machine Service is
// the consumer that owns persisting it as SensorReading rows.
async function startConsumer() {
  await ensureTopics([TOPICS.MACHINES_SENSORS]);
  await subscribe("machine-service", [TOPICS.MACHINES_SENSORS], async (_topic, message) => {
    const { machineId, sensorType, value } = message as { machineId: string; sensorType: string; value: number };
    await prisma.sensorReading.create({ data: { machineId, sensorType, value } });
  });
  logger.info("Subscribed to machines.sensors.readings");
}
startConsumer().catch((error) => logger.error("Kafka consumer failed to start", { error: String(error) }));
