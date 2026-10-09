// Regression coverage for Phase 2's bounded future-slot lookahead (agreed
// with the user): when an operation can't be placed within the normal
// planning horizon, the FORWARD-mode placement loop gets exactly one more
// attempt at a wider, still-fixed horizon before giving up — see
// EXTENDED_HORIZON_DAYS in pipeline.ts.
//
// Real Postgres/Redis, real blockCapacity — no mocking of the capacity
// engine, matching this repo's own established integration-test
// convention. Uses runSchedulingPipeline's test-only horizonOverrideDays
// parameter (small, fast horizons — 2 days normal / 5 days extended)
// instead of realistically saturating ~91 real days of 15-minute Redis
// buckets (~9,600 writes) just to exercise the exact same two-attempt
// logic a tiny horizon proves identically, in milliseconds instead of
// tens of seconds.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma, blockCapacity } from "@aps/domain";
import { redis } from "@aps/shared";
import { runSchedulingPipeline } from "./pipeline";

const HORIZONS = { normal: 2, extended: 5 }; // days

describe("Bounded future-slot lookahead (Phase 2)", () => {
  let enterpriseId: string;
  let plantId: string;
  let wcId: string;
  let machineId: string;
  let routingId: string;
  let productId: string;

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);

    const enterprise = await prisma.enterprise.create({
      data: { name: `test-lookahead-${suffix}`, timezone: "UTC", currency: "USD" },
    });
    enterpriseId = enterprise.id;
    const site = await prisma.site.create({ data: { enterpriseId, name: `test-site-${suffix}`, timezone: "UTC" } });
    const plant = await prisma.plant.create({ data: { siteId: site.id, code: `TEST-LOOKAHEAD-${suffix}`, type: "DISCRETE", capacityUnit: "hours" } });
    plantId = plant.id;

    const wc = await prisma.workCenter.create({ data: { plantId, code: `WC-LA-${suffix}`, type: "MACHINE", workingDaysOfWeek: [0, 1, 2, 3, 4, 5, 6] } });
    wcId = wc.id;
    const machine = await prisma.machine.create({ data: { workCenterId: wcId, name: `M-LA-${suffix}`, type: "ASSEMBLY_LINE", ratedCapacity: 1 } });
    machineId = machine.id;
    await prisma.machineCapability.create({ data: { machineId, operationType: "Op" } });

    const product = await prisma.product.create({ data: { sku: `SKU-LA-${suffix}`, family: "Test Lookahead", uom: "EA", leadTimeDays: 1 } });
    productId = product.id;

    // Deliberately no BOM — checkOperationMaterial treats "no BOM defined"
    // as feasible with no floor, isolating this test to pure scheduling
    // capacity, not material availability (a different, already-covered
    // concern).
    const routing = await prisma.routing.create({ data: { productId, version: "1" } });
    routingId = routing.id;
    await prisma.routingOperation.create({
      data: { routingId, opNumber: 10, operation: "Op", workCenterId: wcId, processingTimeMin: 30, setupTimeMin: 0 },
    });
  });

  afterAll(async () => {
    await prisma.scheduledOperation.deleteMany({ where: { productionOrderId: { startsWith: "" }, machineId } });
    await prisma.resourceReservation.deleteMany({ where: { machineId } });
    await prisma.productionOrder.deleteMany({ where: { plantId } });
    await prisma.routingOperation.deleteMany({ where: { routingId } });
    await prisma.routing.deleteMany({ where: { id: routingId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.machineCapability.deleteMany({ where: { machineId } });
    await prisma.machine.deleteMany({ where: { id: machineId } });
    await prisma.workCenter.deleteMany({ where: { id: wcId } });
    await prisma.plant.deleteMany({ where: { id: plantId } });
    await prisma.site.deleteMany({ where: { enterpriseId } });
    await prisma.enterprise.deleteMany({ where: { id: enterpriseId } });
    await prisma.$disconnect();
  });

  async function makeOrder() {
    const order = await prisma.productionOrder.create({
      data: { plantId, enterpriseId, productId, routingId, quantity: 1, status: "PLANNED", priorityScore: 0 },
    });
    return order.id;
  }

  it("Test 1 — normal horizon has a slot: placed within it, no extended-horizon flag", async () => {
    const orderId = await makeOrder();
    const namespace = `whatif:test:${randomUUID()}`;
    const result = await runSchedulingPipeline(
      plantId, "SINGLE", "FORWARD", { namespace, capacityAdjustments: [] }, orderId, "test", HORIZONS
    );
    expect(result.simulatedOperations).toHaveLength(1);
    expect(result.simulatedOperations![0].viaExtendedHorizon).toBeFalsy();
  });

  it("Test 2 — normal horizon full, extended horizon has a slot: placed, flagged, real date beyond normal horizon", async () => {
    const orderId = await makeOrder();
    const now = new Date();
    // Block the machine solidly through day 3 — beyond the 2-day normal
    // horizon, but inside the 5-day extended one, leaving days 3-5 free.
    const namespace = `whatif:test:${randomUUID()}`;
    await blockCapacity(redis, machineId, { start: now, end: new Date(now.getTime() + 3 * 86_400_000) }, "test block", namespace);

    const result = await runSchedulingPipeline(
      plantId, "SINGLE", "FORWARD", { namespace, capacityAdjustments: [] }, orderId, "test", HORIZONS
    );
    expect(result.simulatedOperations).toHaveLength(1);
    const op = result.simulatedOperations![0];
    expect(op.viaExtendedHorizon).toBe(true);
    const startMs = new Date(op.scheduledStart).getTime();
    expect(startMs).toBeGreaterThanOrEqual(now.getTime() + 3 * 86_400_000 - 60_000); // real date, past the blocked window
    expect(startMs).toBeLessThan(now.getTime() + HORIZONS.extended * 86_400_000);
  });

  it("Test 3 — no feasible slot even within the extended horizon: operation stays unplaced", async () => {
    const orderId = await makeOrder();
    const now = new Date();
    // Block well past even the 5-day extended horizon.
    const namespace = `whatif:test:${randomUUID()}`;
    await blockCapacity(redis, machineId, { start: now, end: new Date(now.getTime() + 8 * 86_400_000) }, "test block", namespace);

    const result = await runSchedulingPipeline(
      plantId, "SINGLE", "FORWARD", { namespace, capacityAdjustments: [] }, orderId, "test", HORIZONS
    );
    expect(result.simulatedOperations ?? []).toHaveLength(0);
  });

  it("Test 4 — default call (no horizonOverrideDays) uses the real constants and is unaffected", async () => {
    const orderId = await makeOrder();
    const namespace = `whatif:test:${randomUUID()}`;
    // No 7th argument — exercises the real production code path exactly
    // as every other real caller does, proving the override is opt-in only.
    const result = await runSchedulingPipeline(plantId, "SINGLE", "FORWARD", { namespace, capacityAdjustments: [] }, orderId, "test");
    expect(result.simulatedOperations).toHaveLength(1);
    expect(result.simulatedOperations![0].viaExtendedHorizon).toBeFalsy();
  });
});
