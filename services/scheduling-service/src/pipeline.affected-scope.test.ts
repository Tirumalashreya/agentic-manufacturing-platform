// Regression coverage for the AFFECTED-scope correctness fix (agreed with
// the user): autoReschedule() used to call runSchedulingPipeline with
// seedProductionOrderId always undefined, which resolveScopedOrderIds()
// treats identically to no scoping at all — every Kafka-triggered
// "AFFECTED" reschedule silently replanned the whole plant. See index.ts's
// autoReschedule/findSeedOrderForWorkCenter and the 4 consumer call sites
// for the fix itself.
//
// Real Postgres, real Prisma — no mocking of the DB layer, matching this
// repo's own established integration-test convention (see agent-orchestrator's
// Python suite). Fixtures live under their own isolated Enterprise/Site/Plant
// so this never touches real demo data, and are torn down in afterAll.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@aps/domain";
import { resolveScopedOrderIds, runSchedulingPipeline } from "./pipeline";

describe("AFFECTED-scope correctness", () => {
  let enterpriseId: string;
  let plantId: string;
  let wcShared: string, wcOther: string;
  let routingSharedId: string, routingOtherId: string;
  let prodSharedId: string, prodOtherId: string;
  let machineId: string;
  let orderA: string, orderB: string, orderC: string, orderD: string;

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);

    const enterprise = await prisma.enterprise.create({
      data: { name: `test-affected-scope-${suffix}`, timezone: "UTC", currency: "USD" },
    });
    enterpriseId = enterprise.id;
    const site = await prisma.site.create({ data: { enterpriseId, name: `test-site-${suffix}`, timezone: "UTC" } });
    const plant = await prisma.plant.create({ data: { siteId: site.id, code: `TEST-AFFECTED-${suffix}`, type: "DISCRETE", capacityUnit: "hours" } });
    plantId = plant.id;

    // A and B share this work center — the "genuinely affected" signal.
    const wcA = await prisma.workCenter.create({ data: { plantId, code: `WC-SHARED-${suffix}`, type: "MACHINE", workingDaysOfWeek: [1, 2, 3, 4, 5] } });
    // C and D sit on a completely different work center — neither shares
    // capacity with A/B, so plain "open order in the same plant" is never
    // enough on its own to pull them into AFFECTED.
    const wcC = await prisma.workCenter.create({ data: { plantId, code: `WC-UNRELATED-${suffix}`, type: "MACHINE", workingDaysOfWeek: [1, 2, 3, 4, 5] } });
    wcShared = wcA.id;
    wcOther = wcC.id;
    const machine = await prisma.machine.create({ data: { workCenterId: wcShared, name: `M-${suffix}`, type: "ASSEMBLY_LINE", ratedCapacity: 1 } });
    machineId = machine.id;
    await prisma.machineCapability.create({ data: { machineId: machine.id, operationType: "Op" } });

    const prodShared = await prisma.product.create({ data: { sku: `SKU-SHARED-${suffix}`, family: "Test", uom: "EA", leadTimeDays: 1 } });
    const prodOther = await prisma.product.create({ data: { sku: `SKU-OTHER-${suffix}`, family: "Test", uom: "EA", leadTimeDays: 1 } });
    prodSharedId = prodShared.id; prodOtherId = prodOther.id;

    const routingShared = await prisma.routing.create({ data: { productId: prodShared.id, version: "1" } });
    await prisma.routingOperation.create({ data: { routingId: routingShared.id, opNumber: 10, operation: "Op", workCenterId: wcShared, processingTimeMin: 5, setupTimeMin: 5 } });
    routingSharedId = routingShared.id;

    const routingOther = await prisma.routing.create({ data: { productId: prodOther.id, version: "1" } });
    await prisma.routingOperation.create({ data: { routingId: routingOther.id, opNumber: 10, operation: "Op", workCenterId: wcC.id, processingTimeMin: 5, setupTimeMin: 5 } });
    routingOtherId = routingOther.id;

    const a = await prisma.productionOrder.create({ data: { plantId, enterpriseId, productId: prodShared.id, routingId: routingShared.id, quantity: 1, status: "PLANNED", priorityScore: 0 } });
    const b = await prisma.productionOrder.create({ data: { plantId, enterpriseId, productId: prodShared.id, routingId: routingShared.id, quantity: 1, status: "PLANNED", priorityScore: 0 } });
    const c = await prisma.productionOrder.create({ data: { plantId, enterpriseId, productId: prodOther.id, routingId: routingOther.id, quantity: 1, status: "PLANNED", priorityScore: 0 } });
    const d = await prisma.productionOrder.create({ data: { plantId, enterpriseId, productId: prodOther.id, routingId: routingOther.id, quantity: 1, status: "PLANNED", priorityScore: 0 } });
    orderA = a.id; orderB = b.id; orderC = c.id; orderD = d.id;

    // A -> D dependency edge, deliberately NOT sharing a work center with A —
    // isolates the dependency-edge signal from the shared-work-center signal.
    await prisma.productionOrderDependency.create({ data: { parentId: orderA, childId: orderD } });
  });

  afterAll(async () => {
    await prisma.scheduledOperation.deleteMany({ where: { productionOrderId: { in: [orderA, orderB, orderC, orderD] } } });
    await prisma.scheduleRun.deleteMany({ where: { plantId } });
    await prisma.productionOrderDependency.deleteMany({ where: { OR: [{ parentId: orderA }, { childId: orderD }] } });
    await prisma.productionOrder.deleteMany({ where: { id: { in: [orderA, orderB, orderC, orderD] } } });
    await prisma.routingOperation.deleteMany({ where: { routingId: { in: [routingSharedId, routingOtherId] } } });
    await prisma.routing.deleteMany({ where: { id: { in: [routingSharedId, routingOtherId] } } });
    await prisma.product.deleteMany({ where: { id: { in: [prodSharedId, prodOtherId] } } });
    await prisma.machineCapability.deleteMany({ where: { machineId } });
    await prisma.machine.deleteMany({ where: { id: machineId } });
    await prisma.workCenter.deleteMany({ where: { id: { in: [wcShared, wcOther] } } });
    await prisma.plant.deleteMany({ where: { id: plantId } });
    await prisma.site.deleteMany({ where: { enterpriseId } });
    await prisma.enterprise.deleteMany({ where: { id: enterpriseId } });
    await prisma.$disconnect();
  });

  it("Test 1 — SINGLE: given A, only A is in scope", async () => {
    const { scopedOrderIds, targetOrderId } = await resolveScopedOrderIds(plantId, "SINGLE", orderA);
    expect(scopedOrderIds).toEqual([orderA]);
    expect(targetOrderId).toBe(orderA);
  });

  it("Test 2 — AFFECTED: A resolved, genuinely affected B included, unrelated C excluded", async () => {
    const { scopedOrderIds, targetOrderId } = await resolveScopedOrderIds(plantId, "AFFECTED", orderA);
    expect(targetOrderId).toBe(orderA);
    expect(scopedOrderIds).toEqual(expect.arrayContaining([orderA, orderB]));
    expect(scopedOrderIds).not.toContain(orderC);
  });

  it("Test 3 — ALL: no seed resolves to unscoped (every eligible order), matching existing ALL behavior", async () => {
    const { scopedOrderIds } = await resolveScopedOrderIds(plantId, "ALL", orderA);
    expect(scopedOrderIds).toBeNull();
  });

  it("Test 4 — autoReschedule's exact call shape: a real seed correctly narrows the pipeline; omitting it (the pre-fix bug) does not", async () => {
    // Phase 2 (agreed with the user): the second (unscoped) call below can
    // now legitimately reach the real extended-horizon retry — the first
    // call already committed real ScheduledOperation/ResourceReservation
    // rows on this fixture's single-machine work centers, so the second,
    // unscoped run may need to search past the normal horizon to place
    // everything. That path now correctly initializes real Redis buckets
    // across the full extended horizon (a real bug fix — see
    // pipeline.ts's ensureBucketsInitialized call site), which is more
    // thorough, and slower, than the default 5s test timeout allows for.
    // Exactly how autoReschedule() calls runSchedulingPipeline post-fix.
    const withSeed = await runSchedulingPipeline(plantId, "AFFECTED", "FORWARD", undefined, orderA, "test: seeded");
    expect(withSeed.scope).toBe("AFFECTED");
    expect(withSeed.scopedOrderIds).toEqual(expect.arrayContaining([orderA, orderB, orderD]));
    expect(withSeed.scopedOrderIds).not.toContain(orderC);
    expect(withSeed.ordersProcessed).toBe(3); // A, B, D — never C

    // The exact pre-fix call shape (seed omitted) — documents the bug this
    // phase closed: AFFECTED with no seed silently becomes indistinguishable
    // from ALL. Guards against this regressing back in.
    const withoutSeed = await runSchedulingPipeline(plantId, "AFFECTED", "FORWARD", undefined, undefined, "test: unseeded (pre-fix shape)");
    expect(withoutSeed.scopedOrderIds).toBeUndefined();
    expect(withoutSeed.ordersProcessed).toBe(4); // every open order in the plant — the bug, still reachable if a caller omits the seed
  }, 30_000);

  it("Test 5 — dependency relationship: A -> D ProductionOrderDependency includes D even with no shared work center", async () => {
    const { scopedOrderIds } = await resolveScopedOrderIds(plantId, "AFFECTED", orderA);
    expect(scopedOrderIds).toContain(orderD);
  });

  it("Test 6 — shared work center: A and B genuinely share a work center, B is included", async () => {
    const { scopedOrderIds } = await resolveScopedOrderIds(plantId, "AFFECTED", orderA);
    expect(scopedOrderIds).toContain(orderB);
  });

  it("Test 7 — unrelated work center: C is not included merely because it is open", async () => {
    const { scopedOrderIds } = await resolveScopedOrderIds(plantId, "AFFECTED", orderA);
    expect(scopedOrderIds).not.toContain(orderC);
  });
});
