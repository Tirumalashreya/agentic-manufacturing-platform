// Stage 01 HIGH-risk debt closure — ARCHITECTURE_BASELINE.md / Stage 01
// verification report, Path 4: SCHEDULE_PUBLISHED's publish() call used to
// be unguarded, inside the pipeline's own outer try/catch — a publish
// failure was caught there and marked the ScheduleRun FAILED, even though
// the real Schedule row (the actual output of the whole run) had already
// committed. This is the highest-blast-radius of the 4 Stage 01 paths:
// an entire scheduling run's result was misrepresented.
//
// Real Postgres, real Prisma, real Kafka, real scheduling pipeline — no
// mocking of the DB or the scheduling algorithm itself, matching
// pipeline.affected-scope.test.ts's own established convention. Only
// `publishTracked` is wrapped to simulate a downstream sync failure.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@aps/domain";

import * as shared from "@aps/shared";
vi.mock("@aps/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aps/shared")>();
  return { ...actual, publishTracked: vi.fn(actual.publishTracked) };
});

// Imported after the mock (vi.mock is hoisted by vitest regardless of
// source order) so this picks up the mocked publishTracked.
import { runSchedulingPipeline } from "./pipeline";

describe("scheduling-service — Stage 01 downstream sync failure after SCHEDULE_PUBLISHED", () => {
  let enterpriseId: string;
  let plantId: string;
  let workCenterId: string;
  let machineId: string;
  let routingId: string;
  let productId: string;
  const productionOrderIds: string[] = [];

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    const enterprise = await prisma.enterprise.create({
      data: { name: `test-sched-publish-${suffix}`, timezone: "UTC", currency: "USD" },
    });
    enterpriseId = enterprise.id;
    const site = await prisma.site.create({ data: { enterpriseId, name: `test-site-${suffix}`, timezone: "UTC" } });
    const plant = await prisma.plant.create({ data: { siteId: site.id, code: `TEST-PUB-${suffix}`, type: "DISCRETE", capacityUnit: "hours" } });
    plantId = plant.id;

    const workCenter = await prisma.workCenter.create({
      data: { plantId, code: `WC-PUB-${suffix}`, type: "MACHINE", workingDaysOfWeek: [1, 2, 3, 4, 5] },
    });
    workCenterId = workCenter.id;
    const machine = await prisma.machine.create({ data: { workCenterId, name: `M-${suffix}`, type: "ASSEMBLY_LINE", ratedCapacity: 1 } });
    machineId = machine.id;
    await prisma.machineCapability.create({ data: { machineId, operationType: "Op" } });

    const product = await prisma.product.create({ data: { sku: `SKU-PUB-${suffix}`, family: "Test", uom: "EA", leadTimeDays: 1 } });
    productId = product.id;
    const routing = await prisma.routing.create({ data: { productId, version: "1" } });
    await prisma.routingOperation.create({
      data: { routingId: routing.id, opNumber: 10, operation: "Op", workCenterId, processingTimeMin: 5, setupTimeMin: 5 },
    });
    routingId = routing.id;
  });

  afterEach(() => {
    vi.mocked(shared.publishTracked).mockRestore();
  });

  afterAll(async () => {
    await prisma.scheduleAuditLog.deleteMany({ where: { entityType: "ScheduleRun" } });
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

  it("successful schedule publication: ScheduleRun COMPLETED, no syncWarning", async () => {
    await freshOrder();
    const result = await runSchedulingPipeline(plantId, "ALL", "FORWARD");

    expect(result.syncWarning).toBeUndefined();
    const run = await prisma.scheduleRun.findUnique({ where: { id: result.runId } });
    expect(run!.status).toBe("COMPLETED");
    const schedule = await prisma.schedule.findFirst({ where: { plantId, versionNumber: result.scheduleVersion } });
    expect(schedule).not.toBeNull();
  });

  it("publication failure: schedule remains persisted, ScheduleRun is COMPLETED (not FAILED, not stuck RUNNING), failure is observable", async () => {
    await freshOrder();
    const cause = new Error("simulated broker unavailable");
    vi.mocked(shared.publishTracked).mockResolvedValueOnce(
      new shared.DownstreamSyncError({ operation: "test", target: "kafka:test", entityId: "placeholder", cause })
    );

    const result = await runSchedulingPipeline(plantId, "ALL", "FORWARD");

    // Observable on the return value.
    expect(result.syncWarning).toContain("simulated broker unavailable");

    // Not falsely FAILED, and not stuck RUNNING — the real, truthful
    // status given that the scheduling run itself genuinely succeeded.
    const run = await prisma.scheduleRun.findUnique({ where: { id: result.runId } });
    expect(run!.status).toBe("COMPLETED");
    expect(run!.finishedAt).not.toBeNull();

    // The schedule itself really persisted despite the publish failure.
    const schedule = await prisma.schedule.findFirst({ where: { plantId, versionNumber: result.scheduleVersion } });
    expect(schedule).not.toBeNull();

    // The failure is durably recorded, not only logged to stdout.
    const auditRow = await prisma.scheduleAuditLog.findFirst({
      where: { entityType: "ScheduleRun", entityId: result.runId },
    });
    expect(auditRow).not.toBeNull();
    expect((auditRow!.after as Record<string, unknown>).event).toBe("SCHEDULE_PUBLISHED_SYNC_FAILED");
  });

  it("rerun/recovery semantics are not accidentally duplicated: a run after a publish failure still gets a clean, incremented version", async () => {
    await freshOrder();
    vi.mocked(shared.publishTracked).mockResolvedValueOnce(
      new shared.DownstreamSyncError({ operation: "test", target: "kafka:test", entityId: "placeholder", cause: new Error("simulated") })
    );
    const failedPublishRun = await runSchedulingPipeline(plantId, "ALL", "FORWARD");

    await freshOrder();
    const nextRun = await runSchedulingPipeline(plantId, "ALL", "FORWARD");

    // No version collision, no duplicate Schedule row, no re-processing of
    // the same version — the next real run picks up exactly where the
    // sync-failed-but-real run left off.
    expect(nextRun.scheduleVersion).toBe(failedPublishRun.scheduleVersion + 1);
    expect(nextRun.syncWarning).toBeUndefined();
    const schedules = await prisma.schedule.findMany({ where: { plantId } });
    const versions = schedules.map((s) => s.versionNumber);
    expect(new Set(versions).size).toBe(versions.length); // no duplicates
  });
});
