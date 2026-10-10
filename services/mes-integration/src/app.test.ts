// Scrap-aware completion work: mes-integration had zero tests before this
// change (confirmed by inspection — no test file, no vitest devDependency).
// Real Postgres, real Prisma, matching this repo's established convention.
//
// Cross-service HTTP calls (inventory-service, order-service,
// agent-orchestrator) are mocked at the `fetch` boundary — the same
// philosophy this codebase already applies to its Kafka boundary (real
// Postgres/Prisma throughout, only the actual remote-process boundary
// simulated). No existing test in this monorepo spins up a sibling
// service as a live process from inside another service's test file;
// genuinely live cross-service proof for this flow is a real limitation
// of this test suite, noted in the implementation report rather than
// silently assumed away.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { prisma, type Prisma } from "@aps/domain";
import { app, claimProductionOrderCompletion, claimStep, planCompletionSteps, attemptCompletionSteps } from "./app";

const AUTH_HEADER = { "x-internal-token": process.env.INTERNAL_SERVICE_TOKEN ?? "" };

async function buildFixture(suffix: string, opts: { twoComponentLines?: boolean; withFulfillmentLine?: boolean; withSalesOrder?: boolean } = {}) {
  const enterprise = await prisma.enterprise.create({ data: { name: `test-mes-${suffix}`, timezone: "UTC", currency: "USD" } });
  const site = await prisma.site.create({ data: { enterpriseId: enterprise.id, name: `test-site-${suffix}`, timezone: "UTC" } });
  const plant = await prisma.plant.create({ data: { siteId: site.id, code: `TEST-MES-${suffix}`, type: "DISCRETE", capacityUnit: "hours" } });
  const finished = await prisma.product.create({ data: { sku: `SKU-FIN-${suffix}`, family: "Test", uom: "EA", leadTimeDays: 1 } });
  const component = await prisma.product.create({ data: { sku: `SKU-COMP-${suffix}`, family: "Test", uom: "EA", leadTimeDays: 1 } });

  const bom = await prisma.bOM.create({ data: { productId: finished.id, version: "1", lotSize: 1 } });
  await prisma.bOMLine.create({ data: { bomId: bom.id, componentId: component.id, quantityPer: 2 } });
  if (opts.twoComponentLines) {
    // Deliberately a SECOND line for the SAME component — proves the
    // idempotency key is scoped to the BOM line, not the component.
    await prisma.bOMLine.create({ data: { bomId: bom.id, componentId: component.id, quantityPer: 1 } });
  }

  const workCenter = await prisma.workCenter.create({ data: { plantId: plant.id, code: `WC-MES-${suffix}`, type: "MACHINE", workingDaysOfWeek: [1, 2, 3, 4, 5] } });
  const routing = await prisma.routing.create({ data: { productId: finished.id, version: "1" } });
  const routingOp = await prisma.routingOperation.create({
    data: { routingId: routing.id, opNumber: 10, operation: "Final Assembly", workCenterId: workCenter.id, processingTimeMin: 30, setupTimeMin: 10 },
  });

  let metadata: Record<string, unknown> = {};
  let fulfillmentLineId: string | undefined;
  let salesOrderId: string | undefined;
  let orderLineId: string | undefined;
  let fulfillmentPlanId: string | undefined;
  let customerId: string | undefined;

  if (opts.withFulfillmentLine || opts.withSalesOrder) {
    const customer = await prisma.customer.create({ data: { name: `Test Customer ${suffix}`, enterpriseId: enterprise.id } });
    customerId = customer.id;
    const salesOrder = await prisma.salesOrder.create({ data: { customerId: customer.id, dueDate: new Date(), value: 1000, enterpriseId: enterprise.id } });
    salesOrderId = salesOrder.id;
    const orderLine = await prisma.orderLine.create({
      data: { orderId: salesOrder.id, productId: finished.id, productName: finished.sku, quantity: 100, unitPrice: 10 },
    });
    orderLineId = orderLine.id;
    const plan = await prisma.fulfillmentPlan.create({ data: { orderLineId: orderLine.id, strategy: "MTO" } });
    fulfillmentPlanId = plan.id;
    const line = await prisma.fulfillmentLine.create({
      data: { fulfillmentPlanId: plan.id, sourceType: "PRODUCTION", quantity: 100, status: "IN_PROGRESS" },
    });
    fulfillmentLineId = line.id;
    if (opts.withFulfillmentLine) metadata.fulfillmentLineId = fulfillmentLineId;
  }

  const productionOrder = await prisma.productionOrder.create({
    data: {
      plantId: plant.id, enterpriseId: enterprise.id, productId: finished.id, routingId: routing.id, bomId: bom.id,
      quantity: 100, status: "IN_PROGRESS", priorityScore: 0,
      salesOrderId: opts.withSalesOrder ? salesOrderId : undefined,
      metadata: Object.keys(metadata).length > 0 ? (metadata as Prisma.InputJsonValue) : undefined,
    },
  });

  const scheduledOp = await prisma.scheduledOperation.create({
    data: {
      productionOrderId: productionOrder.id, routingOperationId: routingOp.id, machineId: null,
      scheduledStart: new Date(), scheduledEnd: new Date(), status: "IN_PROGRESS",
    },
  });

  return {
    enterprise, plant, finished, component, bom, productionOrder, scheduledOp,
    fulfillmentLineId, salesOrderId, orderLineId, fulfillmentPlanId, customerId,
  };
}

// Cleans up exactly the rows this fixture created, by id — never by a
// prefix/contains pattern, which would risk deleting another concurrently
// running test's fixture data.
async function cleanupFixture(f: Awaited<ReturnType<typeof buildFixture>>) {
  await prisma.productionCompletionStep.deleteMany({ where: { productionOrderId: f.productionOrder.id } });
  await prisma.idempotencyKey.deleteMany({ where: { enterpriseId: f.enterprise.id } });
  await prisma.inventoryMovement.deleteMany({ where: { productionOrderId: f.productionOrder.id } });
  if (f.fulfillmentLineId) await prisma.fulfillmentLine.deleteMany({ where: { id: f.fulfillmentLineId } });
  if (f.fulfillmentPlanId) await prisma.fulfillmentPlan.deleteMany({ where: { id: f.fulfillmentPlanId } });
  if (f.orderLineId) await prisma.orderLine.deleteMany({ where: { id: f.orderLineId } });
  if (f.salesOrderId) await prisma.salesOrder.deleteMany({ where: { id: f.salesOrderId } });
  if (f.customerId) await prisma.customer.deleteMany({ where: { id: f.customerId } });
  await prisma.scheduledOperation.deleteMany({ where: { productionOrderId: f.productionOrder.id } });
  await prisma.productionOrder.deleteMany({ where: { id: f.productionOrder.id } });
  await prisma.inventory.deleteMany({ where: { enterpriseId: f.enterprise.id } });
  await prisma.bOMLine.deleteMany({ where: { bomId: f.bom.id } });
  await prisma.bOM.deleteMany({ where: { id: f.bom.id } });
  await prisma.routingOperation.deleteMany({ where: { routing: { productId: f.finished.id } } });
  await prisma.routing.deleteMany({ where: { productId: f.finished.id } });
  await prisma.workCenter.deleteMany({ where: { plantId: f.plant.id } });
  await prisma.product.deleteMany({ where: { id: { in: [f.finished.id, f.component.id] } } });
  await prisma.plant.deleteMany({ where: { id: f.plant.id } });
  await prisma.site.deleteMany({ where: { enterpriseId: f.enterprise.id } });
  await prisma.enterprise.deleteMany({ where: { id: f.enterprise.id } });
}

describe("mes-integration — completion orchestration primitives (no downstream services needed)", () => {
  let fixture: Awaited<ReturnType<typeof buildFixture>>;

  afterEach(async () => {
    if (fixture) await cleanupFixture(fixture);
  });

  it("claimProductionOrderCompletion: of two concurrent callers for the same order, exactly one wins", async () => {
    fixture = await buildFixture(randomUUID().slice(0, 8));
    const [a, b] = await Promise.all([
      claimProductionOrderCompletion(fixture.productionOrder.id, 60, 100),
      claimProductionOrderCompletion(fixture.productionOrder.id, 60, 100),
    ]);
    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.actualGoodUnits).toBe(60);

    const order = await prisma.productionOrder.findUnique({ where: { id: fixture.productionOrder.id } });
    expect(order!.status).toBe("COMPLETED");
  });

  it("claimProductionOrderCompletion: a second call after the order is already COMPLETED also loses", async () => {
    fixture = await buildFixture(randomUUID().slice(0, 8));
    const first = await claimProductionOrderCompletion(fixture.productionOrder.id, 60, 100);
    expect(first).not.toBeNull();
    const second = await claimProductionOrderCompletion(fixture.productionOrder.id, 60, 100);
    expect(second).toBeNull();
  });

  it("planCompletionSteps: one GOODS_ISSUE per BOM line (including two lines sharing a component), one GOODS_RECEIPT, no FULFILLMENT_UPDATE/BILLING when there's no sales order", async () => {
    fixture = await buildFixture(randomUUID().slice(0, 8), { twoComponentLines: true });
    const claimed = await claimProductionOrderCompletion(fixture.productionOrder.id, 100, 100);
    const planned = await planCompletionSteps(claimed!);

    const issueSteps = planned.filter((p) => p.stepType === "GOODS_ISSUE");
    expect(issueSteps).toHaveLength(2); // two BOM lines, same component — two independent steps
    expect(new Set(issueSteps.map((s) => s.stepKey)).size).toBe(2); // keyed by distinct BOM line ids, not the shared componentId

    expect(planned.filter((p) => p.stepType === "GOODS_RECEIPT")).toHaveLength(1);
    expect(planned.filter((p) => p.stepType === "FULFILLMENT_UPDATE")).toHaveLength(0);
    expect(planned.filter((p) => p.stepType === "BILLING")).toHaveLength(0);
  });

  it("planCompletionSteps: plans FULFILLMENT_UPDATE and BILLING when the order metadata/salesOrderId carry them", async () => {
    fixture = await buildFixture(randomUUID().slice(0, 8), { withFulfillmentLine: true, withSalesOrder: true });
    const claimed = await claimProductionOrderCompletion(fixture.productionOrder.id, 60, 100);
    const planned = await planCompletionSteps(claimed!);

    const fulfillment = planned.filter((p) => p.stepType === "FULFILLMENT_UPDATE");
    expect(fulfillment).toHaveLength(1);
    expect(fulfillment[0]!.stepKey).toBe(fixture.fulfillmentLineId);
    expect(planned.filter((p) => p.stepType === "BILLING")).toHaveLength(1);
  });

  it("claimStep: of two concurrent claimers for the same PENDING step, exactly one wins", async () => {
    fixture = await buildFixture(randomUUID().slice(0, 8));
    const step = await prisma.productionCompletionStep.create({
      data: { productionOrderId: fixture.productionOrder.id, stepType: "GOODS_ISSUE", stepKey: "test-line" },
    });
    const results = await Promise.all([claimStep(step.id), claimStep(step.id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("claimStep: a stale IN_PROGRESS claim (worker crashed mid-step) is reclaimable after the lease window", async () => {
    fixture = await buildFixture(randomUUID().slice(0, 8));
    const step = await prisma.productionCompletionStep.create({
      data: {
        productionOrderId: fixture.productionOrder.id, stepType: "GOODS_ISSUE", stepKey: "test-line",
        status: "IN_PROGRESS", claimedAt: new Date(Date.now() - 10 * 60 * 1000), // 10 min ago, past the 5-min lease
      },
    });
    const won = await claimStep(step.id);
    expect(won).toBe(true);
  });

  it("claimStep: a fresh IN_PROGRESS claim (within the lease window) is NOT reclaimable", async () => {
    fixture = await buildFixture(randomUUID().slice(0, 8));
    const step = await prisma.productionCompletionStep.create({
      data: {
        productionOrderId: fixture.productionOrder.id, stepType: "GOODS_ISSUE", stepKey: "test-line",
        status: "IN_PROGRESS", claimedAt: new Date(),
      },
    });
    const won = await claimStep(step.id);
    expect(won).toBe(false);
  });
});

describe("mes-integration — POST /mes/completions full flow (downstream HTTP mocked, Postgres real)", () => {
  let fixture: Awaited<ReturnType<typeof buildFixture>>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let fetchCalls: { url: string; init: RequestInit }[];

  beforeEach(() => {
    fetchCalls = [];
  });

  afterEach(async () => {
    fetchSpy?.mockRestore();
    if (fixture) await cleanupFixture(fixture);
  });

  function mockFetch(responder: (url: string, init: RequestInit) => { status: number; body: unknown } | null) {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
      const url = String(input);
      fetchCalls.push({ url, init: init as RequestInit });
      const result = responder(url, init as RequestInit);
      if (result === null) {
        // analytics-service forward and anything else not under test — succeed harmlessly.
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response(JSON.stringify(result.body), { status: result.status });
    });
  }

  it("happy path: 60 good / 40 rejected produces correctly-scoped goods-issue, goods-receipt, fulfillment-update, and billing calls", async () => {
    fixture = await buildFixture(randomUUID().slice(0, 8), { withFulfillmentLine: true, withSalesOrder: true });
    let movementCounter = 0;
    mockFetch((url) => {
      if (url.includes("/inventory/goods-issue") || url.includes("/inventory/goods-receipt")) {
        return { status: 201, body: { id: `mvmt-${++movementCounter}` } };
      }
      if (url.includes("/fulfillment-lines/")) return { status: 200, body: { id: fixture.fulfillmentLineId } };
      if (url.includes("/complete")) return { status: 200, body: { invoice_id: "INV-TEST-1", billed: true } };
      return null;
    });

    const res = await request(app).post("/mes/completions").set(AUTH_HEADER).send({
      scheduledOperationId: fixture.scheduledOp.id,
      actualStart: new Date().toISOString(),
      actualEnd: new Date().toISOString(),
      goodUnits: 60,
      totalUnits: 100,
      rejectionReason: "tool chatter",
    });
    expect(res.status).toBe(200);

    const order = await prisma.productionOrder.findUnique({ where: { id: fixture.productionOrder.id } });
    expect(order!.status).toBe("COMPLETED");
    expect(order!.actualGoodUnits).toBe(60);
    expect(order!.actualTotalUnits).toBe(100);

    const steps = await prisma.productionCompletionStep.findMany({ where: { productionOrderId: fixture.productionOrder.id } });
    expect(steps.every((s) => s.status === "SUCCEEDED")).toBe(true);
    expect(steps.filter((s) => s.stepType === "GOODS_ISSUE")).toHaveLength(1);

    // Backflush uses the ACTUAL total (100), not a hardcoded planned value —
    // quantityPer 2 * actualTotalUnits 100 = 200.
    const issueCall = fetchCalls.find((c) => c.url.includes("goods-issue"));
    const issueBody = JSON.parse(issueCall!.init.body as string);
    expect(issueBody.quantity).toBe(200);
    expect(issueCall!.init.headers).toMatchObject({ "idempotency-key": expect.stringContaining(":GOODS_ISSUE:") });

    // Receipt is for the ACTUAL GOOD quantity only (60), never the planned 100.
    const receiptCall = fetchCalls.find((c) => c.url.includes("goods-receipt"));
    const receiptBody = JSON.parse(receiptCall!.init.body as string);
    expect(receiptBody.quantity).toBe(60);

    // Fulfillment line gets the actual quantity + a real shortfall reason (100 ordered, 60 fulfilled).
    const fulfillCall = fetchCalls.find((c) => c.url.includes("fulfillment-lines"));
    const fulfillBody = JSON.parse(fulfillCall!.init.body as string);
    expect(fulfillBody.fulfilledQuantity).toBe(60);
    expect(fulfillBody.shortfallReason).toContain("40");

    // Billing is for the actual good quantity, carried in the request body — not re-derived from planned metadata.
    const billingCall = fetchCalls.find((c) => c.url.includes("/complete"));
    const billingBody = JSON.parse(billingCall!.init.body as string);
    expect(billingBody.actualGoodUnits).toBe(60);
  });

  it("concurrent duplicate completion requests for the same final operation produce exactly one full set of downstream calls", async () => {
    fixture = await buildFixture(randomUUID().slice(0, 8), { withSalesOrder: true });
    let issueCalls = 0;
    mockFetch((url) => {
      if (url.includes("goods-issue")) { issueCalls++; return { status: 201, body: { id: "mvmt-1" } }; }
      if (url.includes("goods-receipt")) return { status: 201, body: { id: "mvmt-2" } };
      if (url.includes("/complete")) return { status: 200, body: { invoice_id: "INV-1" } };
      return null;
    });

    const payload = {
      scheduledOperationId: fixture.scheduledOp.id,
      actualStart: new Date().toISOString(),
      actualEnd: new Date().toISOString(),
      goodUnits: 100,
      totalUnits: 100,
    };
    await Promise.all([
      request(app).post("/mes/completions").set(AUTH_HEADER).send(payload),
      request(app).post("/mes/completions").set(AUTH_HEADER).send(payload),
    ]);

    expect(issueCalls).toBe(1); // not 2 — the CAS gate prevented a double-run, proven end-to-end, not just at the unit level
    const movements = await prisma.inventoryMovement.count({ where: { productionOrderId: fixture.productionOrder.id } });
    // (real InventoryMovement rows aren't created here since inventory-service's write is mocked —
    // this assertion documents that mes-integration itself never writes InventoryMovement directly)
    expect(movements).toBe(0);
  });

  it("a failure in GOODS_ISSUE blocks GOODS_RECEIPT/FULFILLMENT_UPDATE/BILLING from being attempted at all (dependency gating)", async () => {
    fixture = await buildFixture(randomUUID().slice(0, 8), { withFulfillmentLine: true, withSalesOrder: true });
    mockFetch((url) => {
      if (url.includes("goods-issue")) return { status: 500, body: { error: "simulated inventory-service outage" } };
      if (url.includes("goods-receipt") || url.includes("fulfillment-lines") || url.includes("/complete")) {
        throw new Error("should never be called — GOODS_ISSUE failed, downstream steps must stay PENDING");
      }
      return null;
    });

    await request(app).post("/mes/completions").set(AUTH_HEADER).send({
      scheduledOperationId: fixture.scheduledOp.id,
      actualStart: new Date().toISOString(),
      actualEnd: new Date().toISOString(),
      goodUnits: 100,
      totalUnits: 100,
    });

    const steps = await prisma.productionCompletionStep.findMany({ where: { productionOrderId: fixture.productionOrder.id } });
    const issue = steps.find((s) => s.stepType === "GOODS_ISSUE")!;
    expect(issue.status).toBe("FAILED");
    expect(issue.lastError).toContain("500");
    for (const type of ["GOODS_RECEIPT", "FULFILLMENT_UPDATE", "BILLING"]) {
      const s = steps.find((st) => st.stepType === type)!;
      expect(s.status).toBe("PENDING"); // never attempted — not a false FAILED signal
    }

    // The order itself is still COMPLETED — operations really did finish;
    // it's only the downstream bookkeeping that's incomplete.
    const order = await prisma.productionOrder.findUnique({ where: { id: fixture.productionOrder.id } });
    expect(order!.status).toBe("COMPLETED");
  });

  it("retry-completion-steps recovers from a partial failure: already-succeeded steps are not re-called, only the failed/pending ones run", async () => {
    fixture = await buildFixture(randomUUID().slice(0, 8), { withSalesOrder: true });
    let issueCalls = 0;
    let receiptShouldFail = true;
    mockFetch((url) => {
      if (url.includes("goods-issue")) { issueCalls++; return { status: 201, body: { id: "mvmt-1" } }; }
      if (url.includes("goods-receipt")) return receiptShouldFail ? { status: 503, body: { error: "simulated" } } : { status: 201, body: { id: "mvmt-2" } };
      if (url.includes("/complete")) return { status: 200, body: { invoice_id: "INV-1" } };
      return null;
    });

    await request(app).post("/mes/completions").set(AUTH_HEADER).send({
      scheduledOperationId: fixture.scheduledOp.id,
      actualStart: new Date().toISOString(),
      actualEnd: new Date().toISOString(),
      goodUnits: 100,
      totalUnits: 100,
    });
    let steps = await prisma.productionCompletionStep.findMany({ where: { productionOrderId: fixture.productionOrder.id } });
    expect(steps.find((s) => s.stepType === "GOODS_ISSUE")!.status).toBe("SUCCEEDED");
    expect(steps.find((s) => s.stepType === "GOODS_RECEIPT")!.status).toBe("FAILED");
    expect(issueCalls).toBe(1);

    receiptShouldFail = false;
    await request(app).post(`/production-orders/${fixture.productionOrder.id}/retry-completion-steps`).set(AUTH_HEADER).send();

    expect(issueCalls).toBe(1); // NOT re-called — already SUCCEEDED, the retry must not redo it
    steps = await prisma.productionCompletionStep.findMany({ where: { productionOrderId: fixture.productionOrder.id } });
    expect(steps.every((s) => s.status === "SUCCEEDED")).toBe(true); // receipt + billing now completed too
  });

  it("GET /production-orders/completion-failures lists an order with a FAILED step", async () => {
    fixture = await buildFixture(randomUUID().slice(0, 8));
    mockFetch((url) => (url.includes("goods-issue") ? { status: 500, body: {} } : null));

    await request(app).post("/mes/completions").set(AUTH_HEADER).send({
      scheduledOperationId: fixture.scheduledOp.id,
      actualStart: new Date().toISOString(),
      actualEnd: new Date().toISOString(),
      goodUnits: 100,
      totalUnits: 100,
    });

    const res = await request(app).get("/production-orders/completion-failures").set(AUTH_HEADER).send();
    expect(res.status).toBe(200);
    const entry = res.body.items.find((i: { productionOrderId: string }) => i.productionOrderId === fixture.productionOrder.id);
    expect(entry).toBeDefined();
    expect(entry.incompleteSteps.some((s: { stepType: string; status: string }) => s.stepType === "GOODS_ISSUE" && s.status === "FAILED")).toBe(true);
  });

  // Note on scope: the CAS-level single-fire guarantee (mes-integration
  // never calls a step's downstream endpoint twice for one completion) is
  // proven above via the concurrent-duplicate test. inventory-service's
  // own Idempotency-Key replay behavior (a retried HTTP call against a
  // real, already-processed key returning the stored result verbatim) is
  // proven in inventory-service's own test suite against its real
  // IdempotencyKey table — a mock here can't demonstrate real persisted
  // replay, so it isn't re-asserted through one.
});
