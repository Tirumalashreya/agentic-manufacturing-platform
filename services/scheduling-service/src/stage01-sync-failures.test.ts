// Stage 01 (Fail Loud, Fail Closed) — ARCHITECTURE_BASELINE.md §5/§6/§11:
// reportProductionException/recordQualityInspection (extracted from
// index.ts's POST .../exceptions and POST .../quality-inspections route
// handlers) must never let a downstream Kafka publish failure look like
// the DB write itself failed or never happened.
//
// Real Postgres, real Prisma — no mocking of the DB layer, matching this
// repo's own established integration-test convention (see
// pipeline.affected-scope.test.ts). Only the Kafka publish step is
// simulated as failing, via a mocked `publishTracked` — the same
// technique used in order-service's app.test.ts for the same reason.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@aps/domain";
import * as shared from "@aps/shared";

vi.mock("@aps/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aps/shared")>();
  return { ...actual, publishTracked: vi.fn(actual.publishTracked) };
});

// Imported from exception-reporting.ts directly, NOT from ./index — index.ts
// unconditionally binds this service's real HTTP port, starts real Kafka
// consumers, and runs a setInterval demo ticker at module load, none of
// which a test may trigger as a side effect (see exception-reporting.ts's
// own doc comment). Imported AFTER the mock is declared (vi.mock is
// hoisted by vitest regardless of source order) so this picks up the
// mocked publishTracked.
import { reportProductionException, recordQualityInspection } from "./exception-reporting";

describe("Stage 01 — downstream sync failure after a committed write (scheduling-service)", () => {
  let enterpriseId: string;
  let plantId: string;
  let workCenterId: string;
  let scheduledOperationId: string;
  const productionOrderIds: string[] = [];

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    const enterprise = await prisma.enterprise.create({
      data: { name: `test-stage01-sched-${suffix}`, timezone: "UTC", currency: "USD" },
    });
    enterpriseId = enterprise.id;
    const site = await prisma.site.create({ data: { enterpriseId, name: `test-site-${suffix}`, timezone: "UTC" } });
    const plant = await prisma.plant.create({ data: { siteId: site.id, code: `TEST-S01-${suffix}`, type: "DISCRETE", capacityUnit: "hours" } });
    plantId = plant.id;
    const workCenter = await prisma.workCenter.create({
      data: { plantId, code: `WC-S01-${suffix}`, type: "MACHINE", workingDaysOfWeek: [1, 2, 3, 4, 5] },
    });
    workCenterId = workCenter.id;
    const product = await prisma.product.create({ data: { sku: `SKU-S01-${suffix}`, family: "Test", uom: "EA", leadTimeDays: 1 } });
    const routing = await prisma.routing.create({ data: { productId: product.id, version: "1" } });
    const routingOp = await prisma.routingOperation.create({
      data: { routingId: routing.id, opNumber: 10, operation: "Op", workCenterId, processingTimeMin: 5, setupTimeMin: 5, requiresInspection: true },
    });
    const productionOrder = await prisma.productionOrder.create({
      data: { plantId, enterpriseId, productId: product.id, routingId: routing.id, quantity: 1, status: "PLANNED", priorityScore: 0 },
    });
    productionOrderIds.push(productionOrder.id);
    const scheduledOp = await prisma.scheduledOperation.create({
      data: {
        productionOrderId: productionOrder.id,
        routingOperationId: routingOp.id,
        scheduledStart: new Date(),
        scheduledEnd: new Date(Date.now() + 60_000),
        status: "DONE",
      },
    });
    scheduledOperationId = scheduledOp.id;
  });

  afterEach(() => {
    vi.mocked(shared.publishTracked).mockRestore();
  });

  afterAll(async () => {
    await prisma.qualityInspection.deleteMany({ where: { scheduledOperationId } });
    await prisma.productionException.deleteMany({ where: { scheduledOperationId } });
    await prisma.scheduledOperation.deleteMany({ where: { productionOrderId: { in: productionOrderIds } } });
    await prisma.productionOrder.deleteMany({ where: { id: { in: productionOrderIds } } });
    await prisma.routingOperation.deleteMany({ where: { workCenterId } });
    await prisma.routing.deleteMany({ where: { productId: { in: [] } } }).catch(() => {});
    await prisma.workCenter.deleteMany({ where: { id: workCenterId } });
    await prisma.plant.deleteMany({ where: { id: plantId } });
    await prisma.site.deleteMany({ where: { enterpriseId } });
    await prisma.enterprise.deleteMany({ where: { id: enterpriseId } });
    await prisma.$disconnect();
  });

  it("TEST 1/TEST 2 — reportProductionException: a publish failure is returned (not thrown/swallowed), and the row is really committed", async () => {
    const cause = new Error("simulated broker unavailable");
    vi.mocked(shared.publishTracked).mockResolvedValueOnce(
      new shared.DownstreamSyncError({ operation: "test", target: "kafka:test", entityId: "placeholder", cause })
    );

    const { created, syncError } = await reportProductionException(scheduledOperationId, "MACHINE_BREAKDOWN", "test note");

    // Not swallowed — the caller gets a real, typed error back, not undefined/void.
    expect(syncError).not.toBeNull();
    expect(syncError!.cause).toBe(cause);
    expect(syncError!.message).toContain("simulated broker unavailable");

    // Not misrepresented as a failed/rolled-back write — the row is real.
    const persisted = await prisma.productionException.findUnique({ where: { id: created.id } });
    expect(persisted).not.toBeNull();
    expect(persisted!.type).toBe("MACHINE_BREAKDOWN");
  });

  it("a successful publish returns syncError: null (no regression on the happy path)", async () => {
    const { syncError } = await reportProductionException(scheduledOperationId, "OTHER", "ok note");
    expect(syncError).toBeNull();
  });

  it("TEST 1/TEST 2 — recordQualityInspection: a FAIL result's linked exception publish failure is reported, not swallowed, and both rows commit", async () => {
    const cause = new Error("simulated broker unavailable");
    // Only the FIRST publishTracked call (the linked ProductionException)
    // fails; the inspection's own publish succeeds — proving each sync
    // failure is tracked independently, not just the first/last one.
    vi.mocked(shared.publishTracked).mockResolvedValueOnce(
      new shared.DownstreamSyncError({ operation: "test", target: "kafka:test", entityId: "placeholder", cause })
    );

    const { created, syncErrors } = await recordQualityInspection(scheduledOperationId, "FAIL", "defect found");

    expect(syncErrors).toHaveLength(1);
    expect(syncErrors[0].cause).toBe(cause);

    const persistedInspection = await prisma.qualityInspection.findUnique({ where: { id: created.id } });
    expect(persistedInspection).not.toBeNull();
    expect(persistedInspection!.result).toBe("FAIL");
    const linkedException = await prisma.productionException.findFirst({
      where: { scheduledOperationId, type: "QUALITY_ISSUE" },
      orderBy: { reportedAt: "desc" },
    });
    expect(linkedException).not.toBeNull();
  });

  it("a PASS result with a successful publish has no syncErrors (no regression on the happy path)", async () => {
    const { syncErrors } = await recordQualityInspection(scheduledOperationId, "PASS", null);
    expect(syncErrors).toHaveLength(0);
  });
});
