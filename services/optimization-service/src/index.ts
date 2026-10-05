
process.env.SERVICE_NAME = "optimization-service";

import { createApp, registerErrorHandler, logger, internalServiceHeaders } from "@aps/shared";
import { prisma } from "@aps/domain";
import { minimizeChangeover, type SequencingJob } from "./tsp";
import { localSearchLoadBalance, type MovableOp } from "./load-balancing";

const app = createApp();
const PORT = Number(process.env.PORT ?? 4006);
const SOLVER_URL = process.env.OPTIMIZATION_SOLVER_URL ?? "http://localhost:4007";

// Called by scheduling-service's step 10 (best-effort, non-blocking). Runs
// the Load Balancing pass for real: moves unstarted operations off
// over-loaded machines onto under-loaded ones with matching capability,
// re-booking each move's ResourceReservation. Changeover-sequencing and
// CP-SAT are exposed as their own endpoints below rather than run
// automatically here, since re-sequencing safely needs precedence context
// this endpoint doesn't have — see the dedicated endpoints' docs.
app.post("/optimize", async (req, res) => {
  const { plantId } = req.body as { plantId?: string };
  if (!plantId) {
    res.status(400).json({ error: "plantId is required" });
    return;
  }

  const workCenters = await prisma.workCenter.findMany({
    where: { plantId },
    include: { machines: { include: { capabilities: true } } },
  });

  const moves: { opId: string; fromMachineId: string; toMachineId: string }[] = [];

  for (const wc of workCenters) {
    if (wc.machines.length < 2) continue;

    const ops = await prisma.scheduledOperation.findMany({
      where: { status: "SCHEDULED", machineId: { in: wc.machines.map((m) => m.id) } },
      include: { routingOperation: true },
    });

    const load = new Map(wc.machines.map((m) => [m.id, 0]));
    for (const op of ops) {
      if (!op.machineId) continue;
      const durationMin = (op.scheduledEnd.getTime() - op.scheduledStart.getTime()) / 60_000;
      load.set(op.machineId, (load.get(op.machineId) ?? 0) + durationMin);
    }

    const movableOps: MovableOp[] = ops
      .filter((op) => op.machineId && op.routingOperation)
      .map((op) => ({
        id: op.id,
        durationMin: (op.scheduledEnd.getTime() - op.scheduledStart.getTime()) / 60_000,
        machineId: op.machineId!,
        eligibleMachineIds: wc.machines
          .filter((m) => m.capabilities.some((c) => c.operationType === op.routingOperation!.operation))
          .map((m) => m.id),
      }));

    const result = localSearchLoadBalance(load, movableOps, /* imbalanceThresholdMin */ 60);
    for (const move of result.moves) {
      await prisma.scheduledOperation.update({ where: { id: move.opId }, data: { machineId: move.toMachineId } });
      await prisma.resourceReservation.updateMany({
        where: { scheduledOperationId: move.opId },
        data: { machineId: move.toMachineId },
      });
      moves.push(move);
    }
  }

  logger.info("Load-balancing pass complete", { plantId, moveCount: moves.length });
  res.json({ moves });
});

// §9 Changeover/Setup Minimisation, directly callable with an explicit job
// list — the caller (e.g. a planner reviewing one machine's queue) supplies
// jobs already known to be sequence-independent of one another.
app.post("/optimize/sequence", (req, res) => {
  const { jobs, changeoverMatrix } = req.body as {
    jobs: SequencingJob[];
    changeoverMatrix: { fromFamily: string; toFamily: string; setupTimeMinutes: number }[];
  };
  const lookup = (from: string, to: string) => {
    if (from === to) return 0;
    const entry = changeoverMatrix.find((c) => c.fromFamily === from && c.toFamily === to);
    return entry?.setupTimeMinutes ?? 0;
  };
  const result = minimizeChangeover(jobs, lookup);
  res.json(result);
});

// Proxies to the real OR-Tools CP-SAT solver (§9, Python service).
app.post("/optimize/cp-sat", async (req, res) => {
  try {
    const response = await fetch(`${SOLVER_URL}/solve/cp-sat`, {
      method: "POST",
      headers: { "content-type": "application/json", ...internalServiceHeaders() },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    logger.error("optimization-solver unreachable", { error: String(error) });
    res.status(502).json({ error: "optimization-solver unreachable" });
  }
});

registerErrorHandler(app);

app.listen(PORT, () => {
  logger.info(`optimization-service listening on :${PORT}`);
});
