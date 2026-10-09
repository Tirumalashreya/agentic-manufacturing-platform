// Phase 11 (Promise Monitoring & Agentic Recovery) — tests for
// checkPromiseImpact (pipeline.ts). Real Postgres, real Prisma — no
// mocking of the DB layer, matching this repo's own established
// convention (see stage01-sync-failures.test.ts). Only the outbound
// fetch() to agent-orchestrator is mocked (vi.stubGlobal) — this is the
// one real external dependency this function has, and the first test in
// this service that needs to mock it.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@aps/domain";
import { checkPromiseImpact } from "./pipeline";

describe("checkPromiseImpact", () => {
  let enterpriseId: string;
  let plantId: string;
  let workCenterId: string;
  let customerId: string;
  const salesOrderIds: string[] = [];
  const productionOrderIds: string[] = [];

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    const enterprise = await prisma.enterprise.create({
      data: { name: `test-promise-impact-${suffix}`, timezone: "UTC", currency: "USD" },
    });
    enterpriseId = enterprise.id;
    const site = await prisma.site.create({ data: { enterpriseId, name: `test-site-${suffix}`, timezone: "UTC" } });
    const plant = await prisma.plant.create({ data: { siteId: site.id, code: `TEST-PI-${suffix}`, type: "DISCRETE", capacityUnit: "hours" } });
    plantId = plant.id;
    const workCenter = await prisma.workCenter.create({
      data: { plantId, code: `WC-PI-${suffix}`, type: "MACHINE", workingDaysOfWeek: [1, 2, 3, 4, 5] },
    });
    workCenterId = workCenter.id;
    const customer = await prisma.customer.create({
      data: { name: `Test Promise Customer ${suffix}`, tier: "STANDARD", slaDays: 14, penaltyPerDay: 0, enterpriseId },
    });
    customerId = customer.id;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await prisma.fulfillmentLine.deleteMany({ where: { fulfillmentPlan: { orderLine: { orderId: { in: salesOrderIds } } } } });
    await prisma.fulfillmentPlan.deleteMany({ where: { orderLine: { orderId: { in: salesOrderIds } } } });
    await prisma.orderLine.deleteMany({ where: { orderId: { in: salesOrderIds } } });
    await prisma.scheduledOperation.deleteMany({ where: { productionOrderId: { in: productionOrderIds } } });
    await prisma.scheduleAuditLog.deleteMany({ where: { entityId: { in: productionOrderIds } } });
    await prisma.idempotencyKey.deleteMany({ where: { enterpriseId } });
    await prisma.productionOrder.deleteMany({ where: { id: { in: productionOrderIds } } });
    await prisma.salesOrder.deleteMany({ where: { id: { in: salesOrderIds } } });
    await prisma.customer.deleteMany({ where: { id: customerId } });
    await prisma.routingOperation.deleteMany({ where: { workCenterId } });
    await prisma.workCenter.deleteMany({ where: { id: workCenterId } });
    await prisma.plant.deleteMany({ where: { id: plantId } });
    await prisma.enterprise.deleteMany({ where: { id: enterpriseId } });
    await prisma.$disconnect();
  });

  // Real end-to-end fixture: a SalesOrder with a real dueDate, a real
  // ProductionOrder linked to it, and a real FulfillmentLine carrying the
  // ACTUAL committed promise (promisedDate) — the exact shape
  // agent-orchestrator's _execute_production_plan writes at approval time.
  async function createPromisedOrder(opts: { promisedDate: Date; newScheduledEnd: Date | null }) {
    const suffix = randomUUID().slice(0, 8);
    const product = await prisma.product.create({ data: { sku: `SKU-PI-${suffix}`, family: "Test", uom: "EA", leadTimeDays: 1 } });
    const salesOrder = await prisma.salesOrder.create({
      data: { customerId, dueDate: opts.promisedDate, enterpriseId, value: 100 },
    });
    salesOrderIds.push(salesOrder.id);
    const orderLine = await prisma.orderLine.create({
      data: { orderId: salesOrder.id, productId: product.id, productName: "Test Widget", quantity: 10, unitPrice: 10 },
    });
    const fulfillmentPlan = await prisma.fulfillmentPlan.create({
      data: { orderLineId: orderLine.id, strategy: "MTO" },
    });
    const routing = await prisma.routing.create({ data: { productId: product.id, version: "1" } });
    const routingOp = await prisma.routingOperation.create({
      data: { routingId: routing.id, opNumber: 10, operation: "Op", workCenterId, processingTimeMin: 30, setupTimeMin: 5 },
    });
    const productionOrder = await prisma.productionOrder.create({
      data: { plantId, enterpriseId, productId: product.id, routingId: routing.id, quantity: 10, status: "RELEASED", priorityScore: 0, salesOrderId: salesOrder.id },
    });
    productionOrderIds.push(productionOrder.id);
    await prisma.fulfillmentLine.create({
      data: {
        fulfillmentPlanId: fulfillmentPlan.id, sourceType: "PRODUCTION", quantity: 10,
        status: "EXECUTION_CREATED", productionOrderId: productionOrder.id, promisedDate: opts.promisedDate,
      },
    });
    if (opts.newScheduledEnd) {
      await prisma.scheduledOperation.create({
        data: {
          productionOrderId: productionOrder.id, routingOperationId: routingOp.id,
          scheduledStart: new Date(opts.newScheduledEnd.getTime() - 3_600_000), scheduledEnd: opts.newScheduledEnd, status: "SCHEDULED",
        },
      });
    }
    return { productionOrder, salesOrder };
  }

  it("1 — promise remains satisfied: no HTTP dispatch, a PROMISE_REMAINS_SAFE audit row is written", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const promisedDate = new Date("2026-12-05T00:00:00Z");
    const { productionOrder } = await createPromisedOrder({ promisedDate, newScheduledEnd: new Date("2026-12-04T10:00:00Z") });

    const run = await prisma.scheduleRun.create({ data: { plantId, scope: "AFFECTED", status: "COMPLETED" } });
    await checkPromiseImpact(plantId, [productionOrder.id], run.id, "MACHINE_BREAKDOWN", "M-104", "test");

    expect(fetchMock).not.toHaveBeenCalled();
    const audit = await prisma.scheduleAuditLog.findFirst({ where: { entityId: productionOrder.id } });
    expect(audit).not.toBeNull();
    expect((audit!.after as { event: string }).event).toBe("PROMISE_REMAINS_SAFE");
  });

  it("2 — promise breached: dispatches a DisruptionEvent with the real original/current promised dates", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const promisedDate = new Date("2026-12-05T00:00:00Z");
    const { productionOrder } = await createPromisedOrder({ promisedDate, newScheduledEnd: new Date("2026-12-10T10:00:00Z") });

    const run = await prisma.scheduleRun.create({ data: { plantId, scope: "AFFECTED", status: "COMPLETED" } });
    await checkPromiseImpact(plantId, [productionOrder.id], run.id, "MACHINE_BREAKDOWN", "M-104", "test");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/disruptions/evaluate");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.disruption_type).toBe("MACHINE_BREAKDOWN");
    expect(body.affected_resource_id).toBe("M-104");
    expect(body.production_order_id).toBe(productionOrder.id);
    expect(new Date(body.original_promised_date).toISOString()).toBe(promisedDate.toISOString());
    expect(new Date(body.current_promised_date).toISOString()).toBe(new Date("2026-12-10T10:00:00Z").toISOString());
  });

  it("3 — an order with no promisedDate at all (no active promise) is silently skipped — no audit row, no dispatch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const suffix = randomUUID().slice(0, 8);
    const product = await prisma.product.create({ data: { sku: `SKU-PI-NOPROMISE-${suffix}`, family: "Test", uom: "EA", leadTimeDays: 1 } });
    const productionOrder = await prisma.productionOrder.create({
      data: { plantId, enterpriseId, productId: product.id, quantity: 5, status: "PLANNED", priorityScore: 0 },
    });
    productionOrderIds.push(productionOrder.id);

    const run = await prisma.scheduleRun.create({ data: { plantId, scope: "AFFECTED", status: "COMPLETED" } });
    await checkPromiseImpact(plantId, [productionOrder.id], run.id, "MACHINE_BREAKDOWN", "M-104", "test");

    expect(fetchMock).not.toHaveBeenCalled();
    const audit = await prisma.scheduleAuditLog.findFirst({ where: { entityId: productionOrder.id } });
    expect(audit).toBeNull();
  });

  it("4 — idempotency: calling checkPromiseImpact twice for the SAME schedule run + order dispatches only once", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const promisedDate = new Date("2026-12-05T00:00:00Z");
    const { productionOrder } = await createPromisedOrder({ promisedDate, newScheduledEnd: new Date("2026-12-10T10:00:00Z") });

    const run = await prisma.scheduleRun.create({ data: { plantId, scope: "AFFECTED", status: "COMPLETED" } });
    await checkPromiseImpact(plantId, [productionOrder.id], run.id, "MACHINE_BREAKDOWN", "M-104", "test");
    await checkPromiseImpact(plantId, [productionOrder.id], run.id, "MACHINE_BREAKDOWN", "M-104", "test");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("5 — agent-orchestrator unavailable: dispatch failure is recorded honestly, never silently treated as resolved", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("connection refused"));
    vi.stubGlobal("fetch", fetchMock);
    const promisedDate = new Date("2026-12-05T00:00:00Z");
    const { productionOrder } = await createPromisedOrder({ promisedDate, newScheduledEnd: new Date("2026-12-10T10:00:00Z") });

    const run = await prisma.scheduleRun.create({ data: { plantId, scope: "AFFECTED", status: "COMPLETED" } });
    await expect(checkPromiseImpact(plantId, [productionOrder.id], run.id, "MACHINE_BREAKDOWN", "M-104", "test")).resolves.not.toThrow();

    const audit = await prisma.scheduleAuditLog.findFirst({ where: { entityId: productionOrder.id } });
    expect(audit).not.toBeNull();
    expect((audit!.after as { event: string }).event).toBe("PROMISE_RECOVERY_DISPATCH_FAILED");
  });

  it("6 — a production order with no newer ScheduledOperation at all is treated as unsatisfied (no silent pass)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const promisedDate = new Date("2026-12-05T00:00:00Z");
    const { productionOrder } = await createPromisedOrder({ promisedDate, newScheduledEnd: null });

    const run = await prisma.scheduleRun.create({ data: { plantId, scope: "AFFECTED", status: "COMPLETED" } });
    await checkPromiseImpact(plantId, [productionOrder.id], run.id, "MACHINE_BREAKDOWN", "M-104", "test");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.current_promised_date).toBeNull();
  });
});
