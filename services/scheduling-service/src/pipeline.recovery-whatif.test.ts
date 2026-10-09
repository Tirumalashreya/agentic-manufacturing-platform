// Phase 13 (Recovery What-If Simulation) — the central requirement this
// phase was given: "The simulation MUST NOT modify committed production/
// scheduling state." This test exists because no existing test anywhere
// in this suite previously exercised runSchedulingPipeline's `whatIf`
// path for scope: "AFFECTED" + a real seedProductionOrderId at all —
// Phase 13 is the first real caller to rely on that exact combination
// (via agent-orchestrator's new simulate_reschedule, see
// manufacturing_services.py), so this proves the zero-write guarantee
// directly rather than trusting pipeline.ts's own doc comments.
//
// Real Postgres, real Prisma, real Redis — same convention as
// pipeline.promise-impact.test.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@aps/domain";
import { redis } from "@aps/shared";
import { runSchedulingPipeline } from "./pipeline";

describe("runSchedulingPipeline — recovery what-if (scope: AFFECTED, mode: BOTTLENECK) never commits", () => {
  let plantId: string;
  let workCenterId: string;
  let productionOrderId: string;
  const productIds: string[] = [];

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    const enterprise = await prisma.enterprise.create({ data: { name: `test-recovery-whatif-${suffix}`, timezone: "UTC", currency: "USD" } });
    const site = await prisma.site.create({ data: { enterpriseId: enterprise.id, name: `test-site-${suffix}`, timezone: "UTC" } });
    const plant = await prisma.plant.create({ data: { siteId: site.id, code: `TEST-RWI-${suffix}`, type: "DISCRETE", capacityUnit: "hours" } });
    plantId = plant.id;
    const workCenter = await prisma.workCenter.create({ data: { plantId, code: `WC-RWI-${suffix}`, type: "MACHINE", workingDaysOfWeek: [1, 2, 3, 4, 5] } });
    workCenterId = workCenter.id;
    const machine = await prisma.machine.create({ data: { workCenterId, name: `M-RWI-${suffix}`, type: "CNC", ratedCapacity: 1 } });
    // Required for machine eligibility — a Machine with no declared
    // MachineCapability row is never eligible for any operation at all
    // (checkMachineCapability), which otherwise makes every placement
    // attempt fail even with the extended-horizon retry. Matches the
    // established fixture pattern (see pipeline.affected-scope.test.ts).
    await prisma.machineCapability.create({ data: { machineId: machine.id, operationType: "Op" } });

    const product = await prisma.product.create({ data: { sku: `SKU-RWI-${suffix}`, family: "Test", uom: "EA", leadTimeDays: 1 } });
    productIds.push(product.id);
    const routing = await prisma.routing.create({ data: { productId: product.id, version: "1" } });
    const routingOp = await prisma.routingOperation.create({
      data: { routingId: routing.id, opNumber: 10, operation: "Op", workCenterId, processingTimeMin: 30, setupTimeMin: 5 },
    });
    const productionOrder = await prisma.productionOrder.create({
      data: { plantId, enterpriseId: enterprise.id, productId: product.id, routingId: routing.id, quantity: 5, status: "PLANNED", priorityScore: 0 },
    });
    productionOrderId = productionOrder.id;
    await prisma.scheduledOperation.create({
      data: {
        productionOrderId, routingOperationId: routingOp.id,
        scheduledStart: new Date("2026-12-01T08:00:00Z"), scheduledEnd: new Date("2026-12-01T10:00:00Z"), status: "SCHEDULED",
      },
    });
  });

  afterAll(async () => {
    await prisma.scheduledOperation.deleteMany({ where: { productionOrderId } });
    await prisma.resourceReservation.deleteMany({ where: { machineId: { not: null }, startTime: { gte: new Date("2025-01-01") } } }).catch(() => {});
    await prisma.productionOrder.deleteMany({ where: { id: productionOrderId } });
    await prisma.routingOperation.deleteMany({ where: { workCenterId } });
    await prisma.machineCapability.deleteMany({ where: { machine: { workCenterId } } });
    await prisma.machine.deleteMany({ where: { workCenterId } });
    await prisma.workCenter.deleteMany({ where: { id: workCenterId } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    const plant = await prisma.plant.findUnique({ where: { id: plantId }, select: { siteId: true } });
    await prisma.plant.deleteMany({ where: { id: plantId } });
    if (plant) {
      const site = await prisma.site.findUnique({ where: { id: plant.siteId }, select: { enterpriseId: true } });
      await prisma.site.deleteMany({ where: { id: plant.siteId } });
      if (site) await prisma.enterprise.deleteMany({ where: { id: site.enterpriseId } });
    }
    await prisma.$disconnect();
  });

  it("returns real simulated operations but writes nothing — no ScheduleRun, no ScheduledOperation change, no ResourceReservation", async () => {
    const before = await prisma.scheduledOperation.findFirst({ where: { productionOrderId } });
    const scheduleRunCountBefore = await prisma.scheduleRun.count({ where: { plantId } });
    const reservationCountBefore = await prisma.resourceReservation.count({ where: { machineId: { not: null } } });

    const namespace = `test-whatif:${randomUUID()}`;
    const result = await runSchedulingPipeline(plantId, "AFFECTED", "BOTTLENECK", { namespace, capacityAdjustments: [] }, productionOrderId);

    // The real simulation actually ran and computed something — this
    // isn't a no-op; it's a real placement that's simply never persisted.
    const myOps = (result.simulatedOperations ?? []).filter((op) => op.productionOrderId === productionOrderId);
    expect(myOps.length).toBeGreaterThan(0);

    const after = await prisma.scheduledOperation.findFirst({ where: { productionOrderId } });
    expect(after?.scheduledStart.toISOString()).toBe(before?.scheduledStart.toISOString());
    expect(after?.scheduledEnd.toISOString()).toBe(before?.scheduledEnd.toISOString());

    const scheduleRunCountAfter = await prisma.scheduleRun.count({ where: { plantId } });
    expect(scheduleRunCountAfter).toBe(scheduleRunCountBefore);

    const reservationCountAfter = await prisma.resourceReservation.count({ where: { machineId: { not: null } } });
    expect(reservationCountAfter).toBe(reservationCountBefore);

    // Cleanup note: runSchedulingPipeline itself only writes into this
    // scratch namespace, never deletes it — that's the HTTP route's own
    // job (see index.ts's POST /scheduling/what-if `finally` block),
    // which this test deliberately bypasses by calling the pipeline
    // function directly. Clean up here so this test doesn't leak Redis
    // memory across runs; this is hygiene, not part of what's asserted.
    const keys = await redis.keys(`cap:*${namespace}*`);
    if (keys.length > 0) await redis.del(...keys);
  });
});
