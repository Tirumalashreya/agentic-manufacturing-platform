// Stage 05 — Schedule Versioning, Validation & Honest Solver Status.
// Real Postgres, real Prisma — no mocking of the DB or the scheduling
// algorithm itself, matching this repo's own established convention
// (pipeline.affected-scope.test.ts / pipeline.schedule-publish-sync.test.ts).
// Only the HTTP layer (idempotency) is exercised via supertest against the
// real Express app; everything else calls runSchedulingPipeline/
// validateScheduleFeasibility directly.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@aps/domain";

import { runSchedulingPipeline, StaleScheduleVersionError } from "./pipeline";
import { validateScheduleFeasibility } from "./schedule-validator";
import { withIdempotency } from "./idempotency";

// A stub standing in for the one real caller (index.ts's POST
// /scheduling/runs route handler) — index.ts itself also calls
// app.listen(...) and subscribes real Kafka consumers at import time, so
// it's deliberately never imported by this repo's own test files (see
// every other pipeline.*.test.ts); this exercises the exact same
// withIdempotency call that route makes, just without binding a port.
function fakeRequest(idempotencyKey: string | undefined, body: unknown) {
  return { header: (name: string) => (name.toLowerCase() === "idempotency-key" ? idempotencyKey : undefined), body };
}
function fakeResponse() {
  const captured: { status: number; body: unknown }[] = [];
  return {
    status(code: number) {
      return { json: (body: unknown) => { captured.push({ status: code, body }); } };
    },
    captured,
  };
}

describe("scheduling-service — Stage 05 schedule versioning / idempotency / stale-commit protection", () => {
  const suffix = randomUUID().slice(0, 8);
  let enterpriseId: string;
  let plantId: string;
  let workCenterId: string;
  let machineId: string;
  let routingId: string;
  let productId: string;
  const productionOrderIds: string[] = [];

  beforeAll(async () => {
    const enterprise = await prisma.enterprise.create({ data: { name: `test-sched-v5-${suffix}`, timezone: "UTC", currency: "USD" } });
    enterpriseId = enterprise.id;
    const site = await prisma.site.create({ data: { enterpriseId, name: `test-site-${suffix}`, timezone: "UTC" } });
    const plant = await prisma.plant.create({ data: { siteId: site.id, code: `TEST-V5-${suffix}`, type: "DISCRETE", capacityUnit: "hours" } });
    plantId = plant.id;

    const workCenter = await prisma.workCenter.create({
      data: { plantId, code: `WC-V5-${suffix}`, type: "MACHINE", workingDaysOfWeek: [1, 2, 3, 4, 5] },
    });
    workCenterId = workCenter.id;
    const machine = await prisma.machine.create({ data: { workCenterId, name: `M-${suffix}`, type: "ASSEMBLY_LINE", ratedCapacity: 1 } });
    machineId = machine.id;
    await prisma.machineCapability.create({ data: { machineId, operationType: "Op" } });

    const product = await prisma.product.create({ data: { sku: `SKU-V5-${suffix}`, family: "Test", uom: "EA", leadTimeDays: 1 } });
    productId = product.id;
    const routing = await prisma.routing.create({ data: { productId, version: "1" } });
    await prisma.routingOperation.create({
      data: { routingId: routing.id, opNumber: 10, operation: "Op", workCenterId, processingTimeMin: 5, setupTimeMin: 5 },
    });
    routingId = routing.id;
  });

  afterAll(async () => {
    await prisma.idempotencyKey.deleteMany({ where: { enterpriseId } });
    await prisma.scheduleAuditLog.deleteMany({ where: { entityType: { in: ["ScheduleRun", "ScheduledOperation"] } } });
    await prisma.resourceReservation.deleteMany({ where: { scheduledOperation: { productionOrderId: { in: productionOrderIds } } } });
    await prisma.scheduledOperation.deleteMany({ where: { productionOrderId: { in: productionOrderIds } } });
    await prisma.scheduleRun.deleteMany({ where: { plantId } });
    await prisma.schedule.deleteMany({ where: { plantId } });
    await prisma.productionOrder.deleteMany({ where: { id: { in: productionOrderIds } } });
    await prisma.routingOperation.deleteMany({ where: { routingId } });
    await prisma.routing.deleteMany({ where: { id: routingId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.machineCapability.deleteMany({ where: { machineId } });
    await prisma.machine.deleteMany({ where: { id: machineId } });
    await prisma.workCenter.deleteMany({ where: { id: workCenterId } });
    await prisma.plant.deleteMany({ where: { id: plantId } });
    await prisma.site.deleteMany({ where: { enterpriseId } });
    await prisma.enterprise.deleteMany({ where: { id: enterpriseId } });
    await prisma.$disconnect();
  });

  async function freshOrder() {
    const order = await prisma.productionOrder.create({
      data: { plantId, enterpriseId, productId, routingId, quantity: 1, status: "PLANNED", priorityScore: 0 },
    });
    productionOrderIds.push(order.id);
    return order.id;
  }

  // --- TEST 1 & 2 (idempotent rerun, exercising the exact withIdempotency
  // call index.ts's POST /scheduling/runs route makes) ---
  it("TEST 1 — same scheduling request rerun with the same Idempotency-Key returns the cached result, no second Schedule version", async () => {
    await freshOrder();
    const idempotencyKey = `sched-rerun-${suffix}`;
    const body = { plantId, scope: "ALL", mode: "FORWARD" };
    const runOnce = async () => ({ status: 200, body: await runSchedulingPipeline(plantId, "ALL", "FORWARD") });

    const res1 = fakeResponse();
    await withIdempotency(fakeRequest(idempotencyKey, body), res1, enterpriseId, "scheduling_run", runOnce);
    expect(res1.captured[0].status).toBe(200);
    const first = res1.captured[0].body as Awaited<ReturnType<typeof runSchedulingPipeline>>;

    const res2 = fakeResponse();
    await withIdempotency(fakeRequest(idempotencyKey, body), res2, enterpriseId, "scheduling_run", runOnce);
    expect(res2.captured[0].status).toBe(200);
    const second = res2.captured[0].body as Awaited<ReturnType<typeof runSchedulingPipeline>>;

    expect(second.runId).toBe(first.runId);
    expect(second.scheduleVersion).toBe(first.scheduleVersion);
    const schedules = await prisma.schedule.findMany({ where: { plantId } });
    expect(schedules.filter((s) => s.versionNumber === first.scheduleVersion).length).toBe(1);
  });

  it("TEST 2 — two concurrent identical requests (same Idempotency-Key) never produce two published versions", async () => {
    await freshOrder();
    const idempotencyKey = `sched-concurrent-${suffix}`;
    const body = { plantId, scope: "ALL", mode: "FORWARD" };
    const runOnce = async () => ({ status: 200, body: await runSchedulingPipeline(plantId, "ALL", "FORWARD") });

    const resA = fakeResponse();
    const resB = fakeResponse();
    await Promise.all([
      withIdempotency(fakeRequest(idempotencyKey, body), resA, enterpriseId, "scheduling_run", runOnce),
      withIdempotency(fakeRequest(idempotencyKey, body), resB, enterpriseId, "scheduling_run", runOnce),
    ]);
    const succeeded = [resA.captured[0], resB.captured[0]].filter((r) => r.status === 200);
    expect(succeeded.length).toBeGreaterThanOrEqual(1);
    const versions = new Set(succeeded.map((r) => (r.body as Awaited<ReturnType<typeof runSchedulingPipeline>>).scheduleVersion));
    expect(versions.size).toBe(1); // every success agrees on the same real version — never two distinct runs
  });

  // --- TEST 3 ---
  it("TEST 3 — a new scheduling request (no idempotency key) creates a separate version and supersedes the previous PUBLISHED one", async () => {
    await freshOrder();
    const first = await runSchedulingPipeline(plantId, "ALL", "FORWARD");
    await freshOrder();
    const second = await runSchedulingPipeline(plantId, "ALL", "FORWARD");

    expect(second.scheduleVersion).toBe(first.scheduleVersion + 1);
    const firstSchedule = await prisma.schedule.findFirst({ where: { plantId, versionNumber: first.scheduleVersion } });
    const secondSchedule = await prisma.schedule.findFirst({ where: { plantId, versionNumber: second.scheduleVersion } });
    expect(firstSchedule!.status).toBe("SUPERSEDED");
    expect(firstSchedule!.supersededAt).not.toBeNull();
    expect(secondSchedule!.status).toBe("PUBLISHED");
  });

  // --- TEST 4 ---
  it("TEST 4 — a run against a stale expectedScheduleVersion is rejected before any write, and the active schedule is untouched", async () => {
    await freshOrder();
    const real = await runSchedulingPipeline(plantId, "ALL", "FORWARD");
    const activeBefore = await prisma.schedule.findFirst({ where: { plantId, status: "PUBLISHED" } });

    await freshOrder();
    await expect(
      runSchedulingPipeline(plantId, "ALL", "FORWARD", undefined, undefined, undefined, undefined, real.scheduleVersion - 1 || 999)
    ).rejects.toBeInstanceOf(StaleScheduleVersionError);

    const activeAfter = await prisma.schedule.findFirst({ where: { plantId, status: "PUBLISHED" } });
    expect(activeAfter!.id).toBe(activeBefore!.id);
    expect(activeAfter!.versionNumber).toBe(real.scheduleVersion);
    const schedules = await prisma.schedule.findMany({ where: { plantId } });
    expect(schedules.length).toBe(1 + (real.scheduleVersion - 1)); // no extra Schedule row from the rejected attempt
  });

  // --- TEST 5 ---
  it("TEST 5 — two concurrent real runs for the same plant (no idempotency key) are serialized by the plant lock: exactly one final published version, no corruption", async () => {
    await freshOrder();
    await freshOrder();
    const results = await Promise.allSettled([
      runSchedulingPipeline(plantId, "ALL", "FORWARD"),
      runSchedulingPipeline(plantId, "ALL", "FORWARD"),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof runSchedulingPipeline>>>[];
    // The plant lock means one may legitimately throw "already in progress"
    // — what must never happen is both succeeding with the SAME version,
    // or the published schedule ending up ambiguous.
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    const versions = new Set(fulfilled.map((r) => r.value.scheduleVersion));
    expect(versions.size).toBe(fulfilled.length); // every successful run got its own distinct version
    const published = await prisma.schedule.findMany({ where: { plantId, status: "PUBLISHED" } });
    expect(published.length).toBe(1); // exactly one active schedule, regardless of how many runs succeeded
  });

  // --- TEST 6 ---
  it("TEST 6 — the independent validator catches two active operations double-booked on the same machine", async () => {
    const orderId = await freshOrder();
    const start = new Date("2027-01-04T09:00:00Z");
    const end = new Date("2027-01-04T10:00:00Z");
    const opA = await prisma.scheduledOperation.create({
      data: { productionOrderId: orderId, machineId, scheduledStart: start, scheduledEnd: end, status: "SCHEDULED" },
    });
    const opB = await prisma.scheduledOperation.create({
      data: { productionOrderId: orderId, machineId, scheduledStart: start, scheduledEnd: end, status: "SCHEDULED" },
    });
    const result = await validateScheduleFeasibility(plantId);
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.includes("double-booked"))).toBe(true);
    await prisma.scheduledOperation.deleteMany({ where: { id: { in: [opA.id, opB.id] } } });
  });

  // --- TEST 7 ---
  it("TEST 7 — the independent validator catches a machine assigned an operation it has no capability for", async () => {
    const orderId = await freshOrder();
    const op = await prisma.scheduledOperation.create({
      data: {
        productionOrderId: orderId,
        routingOperationId: (await prisma.routingOperation.findFirst({ where: { routingId } }))!.id,
        machineId, // this machine only has capability "Op" (seeded in beforeAll) — fine on its own
        scheduledStart: new Date("2027-01-05T09:00:00Z"),
        scheduledEnd: new Date("2027-01-05T10:00:00Z"),
        status: "SCHEDULED",
      },
    });
    // Temporarily strip the machine's capability to force a real violation
    // against the routing operation's required "Op" type.
    await prisma.machineCapability.deleteMany({ where: { machineId } });
    const result = await validateScheduleFeasibility(plantId);
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.includes("Machine eligibility violated"))).toBe(true);

    await prisma.machineCapability.create({ data: { machineId, operationType: "Op" } }); // restore for later tests
    await prisma.scheduledOperation.deleteMany({ where: { id: op.id } });
  });

  // --- TEST 8 ---
  it("TEST 8 — the independent validator catches a precedence violation between two operations of the same order", async () => {
    const secondRoutingOp = await prisma.routingOperation.create({
      data: { routingId, opNumber: 20, operation: "Op", workCenterId, processingTimeMin: 5, setupTimeMin: 0 },
    });
    const firstRoutingOp = (await prisma.routingOperation.findFirst({ where: { routingId, opNumber: 10 } }))!;
    await prisma.routingOpDependency.create({ data: { predecessorId: firstRoutingOp.id, successorId: secondRoutingOp.id } });

    const orderId = await freshOrder();
    // Successor scheduled to START before its predecessor even ENDS — a
    // real precedence violation.
    const predOp = await prisma.scheduledOperation.create({
      data: {
        productionOrderId: orderId, routingOperationId: firstRoutingOp.id, machineId,
        scheduledStart: new Date("2027-01-06T10:00:00Z"), scheduledEnd: new Date("2027-01-06T11:00:00Z"), status: "SCHEDULED",
      },
    });
    const succOp = await prisma.scheduledOperation.create({
      data: {
        productionOrderId: orderId, routingOperationId: secondRoutingOp.id, machineId,
        scheduledStart: new Date("2027-01-06T10:30:00Z"), scheduledEnd: new Date("2027-01-06T11:30:00Z"), status: "SCHEDULED",
      },
    });

    const result = await validateScheduleFeasibility(plantId);
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.includes("Precedence violated"))).toBe(true);

    await prisma.scheduledOperation.deleteMany({ where: { id: { in: [predOp.id, succOp.id] } } });
    await prisma.routingOpDependency.deleteMany({ where: { predecessorId: firstRoutingOp.id, successorId: secondRoutingOp.id } });
    await prisma.routingOperation.deleteMany({ where: { id: secondRoutingOp.id } });
  });

  // --- TEST 11 ---
  it("TEST 11 — a genuinely valid schedule (produced by a real run) passes the independent validator and publishes normally", async () => {
    await freshOrder();
    const result = await runSchedulingPipeline(plantId, "ALL", "FORWARD");
    const schedule = await prisma.schedule.findFirst({ where: { plantId, versionNumber: result.scheduleVersion } });
    expect(schedule!.status).toBe("PUBLISHED");
    const validation = await validateScheduleFeasibility(plantId);
    expect(validation.valid).toBe(true);
    expect(validation.violations).toEqual([]);
  });

  // --- TEST 12 ---
  it("TEST 12 — a superseded schedule version's real placements remain queryable as history, never deleted", async () => {
    // A dedicated machine/routing, isolated from the shared fixture used
    // by every other test above — by this point in the file, the shared
    // machine's real capacity (91-day horizon + 182-day extended lookahead)
    // is already heavily booked by every prior test's own orders, which
    // would make this test's placement fail for a reason that has nothing
    // to do with what it's actually proving (history preservation).
    const dedicatedWorkCenter = await prisma.workCenter.create({
      data: { plantId, code: `WC-V5-T12-${suffix}`, type: "MACHINE", workingDaysOfWeek: [1, 2, 3, 4, 5] },
    });
    const dedicatedMachine = await prisma.machine.create({
      data: { workCenterId: dedicatedWorkCenter.id, name: `M-T12-${suffix}`, type: "ASSEMBLY_LINE", ratedCapacity: 1 },
    });
    await prisma.machineCapability.create({ data: { machineId: dedicatedMachine.id, operationType: "Op-T12" } });
    const dedicatedRouting = await prisma.routing.create({ data: { productId, version: "t12" } });
    await prisma.routingOperation.create({
      data: { routingId: dedicatedRouting.id, opNumber: 10, operation: "Op-T12", workCenterId: dedicatedWorkCenter.id, processingTimeMin: 5, setupTimeMin: 5 },
    });
    const order = await prisma.productionOrder.create({
      data: { plantId, enterpriseId, productId, routingId: dedicatedRouting.id, quantity: 1, status: "PLANNED", priorityScore: 0 },
    });
    const orderId = order.id;
    productionOrderIds.push(orderId);

    // SINGLE scope, seeded on this test's own dedicated order — processes
    // only this order, not the whole plant's accumulated backlog from
    // every earlier test in this file.
    const firstRun = await runSchedulingPipeline(plantId, "SINGLE", "FORWARD", undefined, orderId);
    const firstOpsBefore = await prisma.scheduledOperation.findMany({ where: { productionOrderId: orderId } });
    expect(firstOpsBefore.length).toBeGreaterThan(0);
    const firstOpIds = firstOpsBefore.map((o) => o.id);

    // A second run replans the same (still-open, not protected) order —
    // the first run's real operation rows must still exist afterward.
    const secondRun = await runSchedulingPipeline(plantId, "SINGLE", "FORWARD", undefined, orderId);
    expect(secondRun.scheduleVersion).toBe(firstRun.scheduleVersion + 1);

    const firstOpsAfter = await prisma.scheduledOperation.findMany({ where: { id: { in: firstOpIds } } });
    expect(firstOpsAfter.length).toBe(firstOpIds.length); // still there — not deleted
    expect(firstOpsAfter.every((o) => o.supersededAt !== null)).toBe(true); // but correctly marked historical
    expect(firstOpsAfter.every((o) => o.scheduleVersionId !== null)).toBe(true);

    // And they're still attributable to the real, specific version that
    // created them — real historical evidence, not just "soft-deleted".
    const firstSchedule = await prisma.schedule.findUnique({ where: { id: firstOpsAfter[0].scheduleVersionId! } });
    expect(firstSchedule!.versionNumber).toBe(firstRun.scheduleVersion);
    expect(firstSchedule!.status).toBe("SUPERSEDED");
  });
});
