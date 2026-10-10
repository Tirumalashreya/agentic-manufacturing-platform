// Order-to-production Phase 1 remediation: automated tests for order-service's
// new endpoints (previously none existed for this service). Real Postgres,
// real Prisma, real Kafka — no mocking of the DB or messaging layer, matching
// this repo's own established integration-test convention (see
// scheduling-service's pipeline.affected-scope.test.ts). Uses supertest
// against the exported Express `app` (see app.ts) — no port bound, no
// separate process.
//
// Every fixture lives under its own isolated Enterprise/Site/Plant/Customer,
// named with a random suffix, and is torn down in afterAll — this never
// touches real demo data.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { prisma } from "@aps/domain";
import { app } from "./app";

// Stage 01 (Fail Loud, Fail Closed) tests below need to simulate a
// downstream Kafka publish failure without touching the DB/messaging
// layer's real behavior for every other test in this file (this file's
// own stated convention is real Postgres + real Kafka, no mocking) — so
// only `publishTracked` is wrapped, defaulting to its real implementation
// unless a specific test overrides it with `mockImplementationOnce`.
import * as shared from "@aps/shared";
vi.mock("@aps/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aps/shared")>();
  return { ...actual, publishTracked: vi.fn(actual.publishTracked) };
});

// Real auth, same as every other real caller (requireServiceToken, mounted
// by createApp() on every non-health route) — no bypass for tests.
const AUTH_HEADER = { "x-internal-token": process.env.INTERNAL_SERVICE_TOKEN ?? "" };

// Stage 02 (Tenant Isolation + Service Identity): every route now also
// requires a verified identity assertion — req() mints a real one (not a
// bypass; this exercises the exact signIdentityAssertion/
// verifyIdentityAssertion pair every real caller goes through) scoped to
// whichever enterpriseId the caller asks for, defaulting to this file's
// own test enterprise (set below once it exists).
let defaultEnterpriseId = "";
function identityHeader(enterpriseId: string = defaultEnterpriseId, role = "PLANNER") {
  const token = shared.signIdentityAssertion(
    { sub: "test-user", type: "user", role, enterpriseId, aud: "aps-internal" },
    process.env.INTERNAL_SERVICE_TOKEN ?? ""
  );
  return { "x-identity-assertion": token };
}
const req = (enterpriseId?: string) => ({
  get: (url: string) => request(app).get(url).set(AUTH_HEADER).set(identityHeader(enterpriseId)),
  post: (url: string) => request(app).post(url).set(AUTH_HEADER).set(identityHeader(enterpriseId)),
  patch: (url: string) => request(app).patch(url).set(AUTH_HEADER).set(identityHeader(enterpriseId)),
  delete: (url: string) => request(app).delete(url).set(AUTH_HEADER).set(identityHeader(enterpriseId)),
});

describe("order-service — order-to-production domain endpoints", () => {
  const suffix = randomUUID().slice(0, 8);
  let enterpriseId: string;
  let plantId: string;
  let productId: string;
  let customerId: string;
  let salesOrderId: string;
  const createdCustomerIds: string[] = [];
  const createdSalesOrderIds: string[] = [];
  const createdProductionOrderIds: string[] = [];

  beforeAll(async () => {
    const enterprise = await prisma.enterprise.create({
      data: { name: `test-order-service-${suffix}`, timezone: "UTC", currency: "USD" },
    });
    enterpriseId = enterprise.id;
    defaultEnterpriseId = enterpriseId;
    const site = await prisma.site.create({ data: { enterpriseId, name: `test-site-${suffix}`, timezone: "UTC" } });
    const plant = await prisma.plant.create({ data: { siteId: site.id, code: `TEST-ORDSVC-${suffix}`, type: "DISCRETE", capacityUnit: "hours" } });
    plantId = plant.id;
    const product = await prisma.product.create({ data: { sku: `SKU-ORDSVC-${suffix}`, family: "Test", uom: "EA", leadTimeDays: 1 } });
    productId = product.id;

    const customer = await prisma.customer.create({
      data: { name: `Test Customer ${suffix}`, tier: "STANDARD", slaDays: 14, penaltyPerDay: 0, enterpriseId },
    });
    customerId = customer.id;
    createdCustomerIds.push(customerId);
  });

  afterAll(async () => {
    await prisma.fulfillmentLine.deleteMany({ where: { fulfillmentPlan: { orderLine: { orderId: { in: createdSalesOrderIds } } } } });
    await prisma.fulfillmentPlan.deleteMany({ where: { orderLine: { orderId: { in: createdSalesOrderIds } } } });
    await prisma.orderLine.deleteMany({ where: { orderId: { in: createdSalesOrderIds } } });
    await prisma.scheduledOperation.deleteMany({ where: { productionOrderId: { in: createdProductionOrderIds } } });
    await prisma.productionOrder.deleteMany({ where: { id: { in: createdProductionOrderIds } } });
    await prisma.auditLog.deleteMany({ where: { entityType: "SalesOrder", entityId: { in: createdSalesOrderIds } } });
    await prisma.salesOrder.deleteMany({ where: { id: { in: createdSalesOrderIds } } });
    await prisma.customer.deleteMany({ where: { id: { in: createdCustomerIds } } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.plant.deleteMany({ where: { id: plantId } });
    // Stage 03C Part B tests claim real IdempotencyKey rows under this
    // enterprise (POST /orders) — same FK-safe cleanup POST /sales-orders'
    // own describe block already needs for its own idempotency tests.
    await prisma.idempotencyKey.deleteMany({ where: { enterpriseId } });
    await prisma.site.deleteMany({ where: { enterpriseId } });
    await prisma.enterprise.deleteMany({ where: { id: enterpriseId } });
    await prisma.$disconnect();
  });

  describe("GET /customers?name=", () => {
    it("finds an existing customer by exact name", async () => {
      const res = await req().get("/customers").query({ name: `Test Customer ${suffix}` });
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe(customerId);
    });

    it("returns an empty array for a name with no match", async () => {
      const res = await req().get("/customers").query({ name: `nonexistent-${suffix}` });
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("returns an empty array with no name query param, rather than every customer", async () => {
      const res = await req().get("/customers");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe("POST /sales-orders", () => {
    it("creates a real SalesOrder row with the order-to-production fields", async () => {
      const res = await req().post("/sales-orders").send({
        customerId,
        dueDate: "2026-12-01",
        value: 9000,
        priority: 0,
        orderNumber: `SO-TEST-${suffix}`,
        channel: "domestic_sales",
        fulfillmentType: "MTS",
        status: "APPROVED",
        currency: "INR",
        createdBy: "test",
        externalOrderId: `SO-TEST-${suffix}`,
      });
      expect(res.status).toBe(201);
      expect(res.body.customerId).toBe(customerId);
      expect(res.body.fulfillmentType).toBe("MTS");
      expect(res.body.externalOrderId).toBe(`SO-TEST-${suffix}`);
      salesOrderId = res.body.id;
      createdSalesOrderIds.push(salesOrderId);

      const inDb = await prisma.salesOrder.findUnique({ where: { id: salesOrderId } });
      expect(inDb).not.toBeNull();
      expect(inDb!.status).toBe("APPROVED");
    });

    it("rejects a duplicate externalOrderId with a clean 409, not a raw 500", async () => {
      const res = await req().post("/sales-orders").send({
        customerId,
        dueDate: "2026-12-01",
        value: 1,
        priority: 0,
        externalOrderId: `SO-TEST-${suffix}`, // same as above — real duplicate
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already exists/i);

      const count = await prisma.salesOrder.count({ where: { externalOrderId: `SO-TEST-${suffix}` } });
      expect(count).toBe(1); // the duplicate attempt did not create a second row
    });
  });

  describe("Stage 07 — correlation + audit trail", () => {
    it("echoes an inbound x-trace-id header on the response untouched", async () => {
      const traceId = `trace-test-${suffix}`;
      const res = await req()
        .get("/customers?name=nonexistent")
        .set("x-trace-id", traceId);
      expect(res.headers["x-trace-id"]).toBe(traceId);
    });

    it("mints a fresh x-trace-id when the caller sends none", async () => {
      const res = await req().get("/customers?name=nonexistent");
      expect(res.headers["x-trace-id"]).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("writes an AuditLog row scoped to the correct enterprise/actor/trace on real SalesOrder creation", async () => {
      const traceId = `trace-audit-${suffix}`;
      const res = await req()
        .post("/sales-orders")
        .set("x-trace-id", traceId)
        .send({
          customerId,
          dueDate: "2026-12-01",
          value: 500,
          priority: 0,
          orderNumber: `SO-AUDIT-${suffix}`,
          channel: "domestic_sales",
          fulfillmentType: "MTS",
          status: "APPROVED",
          currency: "INR",
          createdBy: "test",
          externalOrderId: `SO-AUDIT-${suffix}`,
        });
      expect(res.status).toBe(201);
      createdSalesOrderIds.push(res.body.id);

      const auditRow = await prisma.auditLog.findFirst({
        where: { entityType: "SalesOrder", entityId: res.body.id },
      });
      expect(auditRow).not.toBeNull();
      expect(auditRow!.action).toBe("CREATED");
      expect(auditRow!.actorId).toBe("test-user");
      expect(auditRow!.enterpriseId).toBe(defaultEnterpriseId);
      expect(auditRow!.traceId).toBe(traceId);
    });

    it("never attributes an AuditLog row to a different tenant than the one that created it", async () => {
      const auditRow = await prisma.auditLog.findFirst({
        where: { entityType: "SalesOrder", entityId: salesOrderId },
      });
      expect(auditRow).not.toBeNull();
      expect(auditRow!.enterpriseId).toBe(defaultEnterpriseId);
      expect(auditRow!.enterpriseId).not.toBe("some-other-enterprise");
    });
  });

  describe("GET /sales-orders?externalOrderId=", () => {
    it("finds the real order by its mock-ERP externalOrderId", async () => {
      const res = await req().get("/sales-orders").query({ externalOrderId: `SO-TEST-${suffix}` });
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe(salesOrderId);
    });

    it("returns an empty array for an unknown externalOrderId", async () => {
      const res = await req().get("/sales-orders").query({ externalOrderId: "SO-DOES-NOT-EXIST" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe("POST /sales-orders/:id/fulfillment — STOCK", () => {
    it("creates OrderLine -> FulfillmentPlan(MTS) -> one STOCK FulfillmentLine, correctly linked", async () => {
      const res = await req().post(`/sales-orders/${salesOrderId}/fulfillment`).send({
        productId,
        productName: "Test Widget",
        quantity: 50,
        unitPrice: 900,
        strategy: "MTS",
        reasoning: "fully in stock",
        lines: [{ sourceType: "STOCK", quantity: 50 }],
      });
      expect(res.status).toBe(201);
      expect(res.body.fulfillmentLines).toHaveLength(1);
      expect(res.body.fulfillmentLines[0].sourceType).toBe("STOCK");

      // Assert the real relational chain, not just the response payload.
      const order = await prisma.salesOrder.findUnique({
        where: { id: salesOrderId },
        include: { orderLines: { include: { fulfillmentPlan: { include: { lines: true } } } } },
      });
      expect(order!.orderLines).toHaveLength(1);
      const line = order!.orderLines[0];
      expect(line.quantity).toBe(50);
      expect(line.fulfillmentPlan!.strategy).toBe("MTS");
      expect(line.fulfillmentPlan!.lines).toHaveLength(1);
      expect(line.fulfillmentPlan!.lines[0].sourceType).toBe("STOCK");
      expect(line.fulfillmentPlan!.lines[0].quantity).toBe(50);
    });
  });

  describe("POST /sales-orders/:id/fulfillment — validation", () => {
    it("404s for a nonexistent order", async () => {
      const res = await req().post("/sales-orders/does-not-exist/fulfillment").send({
        productName: "X", quantity: 10, unitPrice: 1, strategy: "MTS",
        lines: [{ sourceType: "STOCK", quantity: 10 }],
      });
      expect(res.status).toBe(404);
    });

    it("400s for an invalid fulfillment quantity (zero/negative)", async () => {
      const res = await req().post(`/sales-orders/${salesOrderId}/fulfillment`).send({
        productName: "X", quantity: 10, unitPrice: 1, strategy: "MTS",
        lines: [{ sourceType: "STOCK", quantity: 0 }],
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/positive number/i);
    });

    it("400s for an invalid sourceType", async () => {
      const res = await req().post(`/sales-orders/${salesOrderId}/fulfillment`).send({
        productName: "X", quantity: 10, unitPrice: 1, strategy: "MTS",
        lines: [{ sourceType: "NOT_A_REAL_TYPE", quantity: 10 }],
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid sourceType/i);
    });

    it("400s when fulfillment-line quantities don't sum to the order quantity — this is the SalesOrder quantity invariant", async () => {
      const res = await req().post(`/sales-orders/${salesOrderId}/fulfillment`).send({
        productName: "X", quantity: 100, unitPrice: 1, strategy: "HYBRID",
        lines: [{ sourceType: "STOCK", quantity: 40 }, { sourceType: "PRODUCTION", quantity: 40 }], // sums to 80, not 100
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/must equal the order line quantity/i);
    });

    it("does not persist anything when validation fails (transactional rollback / no partial writes)", async () => {
      const before = await prisma.orderLine.count({ where: { orderId: salesOrderId } });
      await req().post(`/sales-orders/${salesOrderId}/fulfillment`).send({
        productName: "X", quantity: 100, unitPrice: 1, strategy: "HYBRID",
        lines: [{ sourceType: "STOCK", quantity: 40 }, { sourceType: "PRODUCTION", quantity: 40 }],
      });
      const after = await prisma.orderLine.count({ where: { orderId: salesOrderId } });
      expect(after).toBe(before); // no new OrderLine, no orphaned FulfillmentPlan
    });
  });

  describe("POST /sales-orders/:id/fulfillment — HYBRID, then PRODUCTION linkage", () => {
    let hybridSalesOrderId: string;
    let hybridFulfillmentLines: Array<{ id: string; sourceType: string }>;
    let productionOrderId: string;

    beforeAll(async () => {
      const soRes = await req().post("/sales-orders").send({
        customerId, dueDate: "2026-12-01", value: 5000, priority: 0,
        externalOrderId: `SO-HYBRID-${suffix}`, fulfillmentType: "HYBRID", status: "APPROVED", currency: "INR",
      });
      hybridSalesOrderId = soRes.body.id;
      createdSalesOrderIds.push(hybridSalesOrderId);

      const res = await req().post(`/sales-orders/${hybridSalesOrderId}/fulfillment`).send({
        productId, productName: "Test Widget", quantity: 100, unitPrice: 900,
        strategy: "HYBRID", reasoning: "partial stock",
        lines: [{ sourceType: "STOCK", quantity: 60 }, { sourceType: "PRODUCTION", quantity: 40 }],
      });
      hybridFulfillmentLines = res.body.fulfillmentLines;
    });

    it("creates exactly two fulfillment lines (STOCK + PRODUCTION) summing to the order quantity, each independently PENDING", async () => {
      expect(hybridFulfillmentLines).toHaveLength(2);
      const sourceTypes = hybridFulfillmentLines.map((l) => l.sourceType).sort();
      expect(sourceTypes).toEqual(["PRODUCTION", "STOCK"]);

      const order = await prisma.salesOrder.findUnique({
        where: { id: hybridSalesOrderId },
        include: { orderLines: { include: { fulfillmentPlan: { include: { lines: true } } } } },
      });
      const lines = order!.orderLines[0].fulfillmentPlan!.lines;
      const total = lines.reduce((sum, l) => sum + l.quantity, 0);
      expect(total).toBe(100); // STOCK(60) + PRODUCTION(40) === SalesOrder quantity
      expect(lines.every((l) => l.status === "PENDING")).toBe(true);
      // Nothing has progressed yet — order status reflects that, not COMPLETED.
      expect(order!.status).toBe("APPROVED");
    });

    it("404s when patching a nonexistent FulfillmentLine", async () => {
      const res = await req().patch("/fulfillment-lines/does-not-exist").send({ status: "FULFILLED" });
      expect(res.status).toBe(404);
    });

    it("404s when patching to a nonexistent ProductionOrder (clean error, not a raw FK 500)", async () => {
      const productionLine = hybridFulfillmentLines.find((l) => l.sourceType === "PRODUCTION")!;
      const res = await req().patch(`/fulfillment-lines/${productionLine.id}`).send({
        productionOrderId: "does-not-exist",
      });
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/No ProductionOrder found/i);
    });

    it("400s for an invalid status value", async () => {
      const productionLine = hybridFulfillmentLines.find((l) => l.sourceType === "PRODUCTION")!;
      const res = await req().patch(`/fulfillment-lines/${productionLine.id}`).send({ status: "NOT_A_REAL_STATUS" });
      expect(res.status).toBe(400);
    });

    it("400s for an illegal lifecycle transition (PENDING straight to FULFILLED, skipping execution)", async () => {
      const stockLine = hybridFulfillmentLines.find((l) => l.sourceType === "STOCK")!;
      const res = await req().patch(`/fulfillment-lines/${stockLine.id}`).send({ status: "FULFILLED" });
      // PENDING -> FULFILLED is not a legal direct transition in
      // FULFILLMENT_LINE_TRANSITIONS (must pass through ALLOCATED/
      // EXECUTION_CREATED/IN_PROGRESS first).
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid transition/i);

      const inDb = await prisma.fulfillmentLine.findUnique({ where: { id: stockLine.id } });
      expect(inDb!.status).toBe("PENDING"); // rejected — no partial state change persisted
    });

    it("allows the legal PENDING -> ALLOCATED -> FULFILLED path for the STOCK leg, and rolls the order up to PARTIALLY_FULFILLED", async () => {
      const stockLine = hybridFulfillmentLines.find((l) => l.sourceType === "STOCK")!;

      const allocated = await req().patch(`/fulfillment-lines/${stockLine.id}`).send({ status: "ALLOCATED" });
      expect(allocated.status).toBe(200);

      const fulfilled = await req().patch(`/fulfillment-lines/${stockLine.id}`).send({
        status: "FULFILLED", executionReference: "RSV-TEST-1",
      });
      expect(fulfilled.status).toBe(200);
      expect(fulfilled.body.executionReference).toBe("RSV-TEST-1");

      // The PRODUCTION leg is still PENDING — order-level status must
      // reflect the mixed state, not silently treat the order as done.
      const order = await prisma.salesOrder.findUnique({ where: { id: hybridSalesOrderId } });
      expect(order!.status).toBe("PARTIALLY_FULFILLED");
    });

    it("links the PRODUCTION FulfillmentLine to a real ProductionOrder via PATCH /fulfillment-lines/:id", async () => {
      const productionLine = hybridFulfillmentLines.find((l) => l.sourceType === "PRODUCTION")!;

      const orderRes = await req().post("/orders").send({
        plantId, productId, quantity: 40,
      });
      productionOrderId = orderRes.body.id;
      createdProductionOrderIds.push(productionOrderId);

      const patchRes = await req().patch(`/fulfillment-lines/${productionLine.id}`).send({
        productionOrderId, status: "EXECUTION_CREATED",
      });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.productionOrderId).toBe(productionOrderId);

      // Real relational check: FulfillmentLine -> ProductionOrder linkage.
      const inDb = await prisma.fulfillmentLine.findUnique({ where: { id: productionLine.id } });
      expect(inDb!.productionOrderId).toBe(productionOrderId);

      // Both legs have now progressed past PENDING/FULFILLED-mixed, but
      // the order isn't COMPLETED until the PRODUCTION leg is too —
      // independent lifecycles, correctly rolled up.
      const order = await prisma.salesOrder.findUnique({ where: { id: hybridSalesOrderId } });
      expect(order!.status).toBe("PARTIALLY_FULFILLED");
    });

    it("a FulfillmentLine cannot have an execution document belonging to another fulfillment (duplicate/reassignment prevention)", async () => {
      const productionLine = hybridFulfillmentLines.find((l) => l.sourceType === "PRODUCTION")!;

      // A second, different real ProductionOrder — attempting to attach it
      // to a line already linked to a different one must be rejected, not
      // silently overwrite the real linkage.
      const otherOrderRes = await req().post("/orders").send({ plantId, productId, quantity: 5 });
      const otherProductionOrderId = otherOrderRes.body.id;
      createdProductionOrderIds.push(otherProductionOrderId);

      const res = await req().patch(`/fulfillment-lines/${productionLine.id}`).send({
        productionOrderId: otherProductionOrderId,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/already linked/i);

      const inDb = await prisma.fulfillmentLine.findUnique({ where: { id: productionLine.id } });
      expect(inDb!.productionOrderId).toBe(productionOrderId); // unchanged — still the original, correct link
    });

    it("a non-PRODUCTION line cannot be given a productionOrderId at all", async () => {
      const stockLine = hybridFulfillmentLines.find((l) => l.sourceType === "STOCK")!;
      const orderRes = await req().post("/orders").send({ plantId, productId, quantity: 1 });
      createdProductionOrderIds.push(orderRes.body.id);

      const res = await req().patch(`/fulfillment-lines/${stockLine.id}`).send({ productionOrderId: orderRes.body.id });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/only a PRODUCTION line/i);
    });

    it("PATCH /orders/:id sets a real ProductionOrder.salesOrderId FK back to the correct SalesOrder", async () => {
      const res = await req().patch(`/orders/${productionOrderId}`).send({ salesOrderId: hybridSalesOrderId });
      expect(res.status).toBe(200);
      expect(res.body.salesOrderId).toBe(hybridSalesOrderId);

      const inDb = await prisma.productionOrder.findUnique({ where: { id: productionOrderId } });
      expect(inDb!.salesOrderId).toBe(hybridSalesOrderId); // points back to the correct SalesOrder, not just any
    });

    it("404s when PATCH /orders/:id is given a nonexistent salesOrderId", async () => {
      const res = await req().patch(`/orders/${productionOrderId}`).send({ salesOrderId: "does-not-exist" });
      expect(res.status).toBe(404);
    });

    it("completing the PRODUCTION leg rolls the whole order up to COMPLETED", async () => {
      const productionLine = hybridFulfillmentLines.find((l) => l.sourceType === "PRODUCTION")!;
      const res = await req().patch(`/fulfillment-lines/${productionLine.id}`).send({ status: "FULFILLED" });
      expect(res.status).toBe(200);

      const order = await prisma.salesOrder.findUnique({ where: { id: hybridSalesOrderId } });
      expect(order!.status).toBe("COMPLETED"); // all lines FULFILLED now
    });

    it("GET /sales-orders/:id/fulfillment returns the full, correctly-linked SalesOrder -> OrderLine -> FulfillmentPlan -> FulfillmentLine -> ProductionOrder chain", async () => {
      const res = await req().get(`/sales-orders/${hybridSalesOrderId}/fulfillment`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(hybridSalesOrderId);
      expect(res.body.status).toBe("COMPLETED");
      const line = res.body.orderLines[0];
      expect(line.quantity).toBe(100);
      const plan = line.fulfillmentPlan;
      expect(plan.strategy).toBe("HYBRID");
      const productionLeg = plan.lines.find((l: { sourceType: string }) => l.sourceType === "PRODUCTION");
      expect(productionLeg.productionOrderId).toBe(productionOrderId);
      const stockLeg = plan.lines.find((l: { sourceType: string }) => l.sourceType === "STOCK");
      expect(stockLeg.quantity + productionLeg.quantity).toBe(100);
    });

    it("404s for GET /sales-orders/:id/fulfillment on a nonexistent order", async () => {
      const res = await req().get("/sales-orders/does-not-exist/fulfillment");
      expect(res.status).toBe(404);
    });
  });

  describe("fulfillment lifecycle — terminal states and CANCELLED order rollup", () => {
    let cancelSalesOrderId: string;
    let cancelLineId: string;

    beforeAll(async () => {
      const soRes = await req().post("/sales-orders").send({
        customerId, dueDate: "2026-12-01", value: 900, priority: 0,
        externalOrderId: `SO-CANCEL-${suffix}`, fulfillmentType: "MTS", status: "APPROVED", currency: "INR",
      });
      cancelSalesOrderId = soRes.body.id;
      createdSalesOrderIds.push(cancelSalesOrderId);
      const res = await req().post(`/sales-orders/${cancelSalesOrderId}/fulfillment`).send({
        productId, productName: "Test Widget", quantity: 5, unitPrice: 900,
        strategy: "MTS", lines: [{ sourceType: "STOCK", quantity: 5 }],
      });
      cancelLineId = res.body.fulfillmentLines[0].id;
    });

    it("a FULFILLED line has no further legal transitions (terminal state enforced)", async () => {
      await req().patch(`/fulfillment-lines/${cancelLineId}`).send({ status: "ALLOCATED" });
      await req().patch(`/fulfillment-lines/${cancelLineId}`).send({ status: "FULFILLED" });

      const res = await req().patch(`/fulfillment-lines/${cancelLineId}`).send({ status: "CANCELLED" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid transition/i);
    });

    it("all lines CANCELLED rolls the order up to CANCELLED", async () => {
      const soRes = await req().post("/sales-orders").send({
        customerId, dueDate: "2026-12-01", value: 900, priority: 0,
        externalOrderId: `SO-CANCEL2-${suffix}`, fulfillmentType: "MTS", status: "APPROVED", currency: "INR",
      });
      createdSalesOrderIds.push(soRes.body.id);
      const fRes = await req().post(`/sales-orders/${soRes.body.id}/fulfillment`).send({
        productId, productName: "Test Widget", quantity: 5, unitPrice: 900,
        strategy: "MTS", lines: [{ sourceType: "STOCK", quantity: 5 }],
      });
      const lineId = fRes.body.fulfillmentLines[0].id;
      await req().patch(`/fulfillment-lines/${lineId}`).send({ status: "CANCELLED" });

      const order = await prisma.salesOrder.findUnique({ where: { id: soRes.body.id } });
      expect(order!.status).toBe("CANCELLED");
    });

    it("a FAILED line rolls the order up to ON_HOLD, and can retry back to PENDING", async () => {
      const soRes = await req().post("/sales-orders").send({
        customerId, dueDate: "2026-12-01", value: 900, priority: 0,
        externalOrderId: `SO-RETRY-${suffix}`, fulfillmentType: "MTS", status: "APPROVED", currency: "INR",
      });
      createdSalesOrderIds.push(soRes.body.id);
      const fRes = await req().post(`/sales-orders/${soRes.body.id}/fulfillment`).send({
        productId, productName: "Test Widget", quantity: 5, unitPrice: 900,
        strategy: "MTS", lines: [{ sourceType: "STOCK", quantity: 5 }],
      });
      const lineId = fRes.body.fulfillmentLines[0].id;

      const failRes = await req().patch(`/fulfillment-lines/${lineId}`).send({ status: "FAILED" });
      expect(failRes.status).toBe(200);
      let order = await prisma.salesOrder.findUnique({ where: { id: soRes.body.id } });
      expect(order!.status).toBe("ON_HOLD");

      // Retry — a real requirement from the target lifecycle (section 4).
      const retryRes = await req().patch(`/fulfillment-lines/${lineId}`).send({ status: "PENDING" });
      expect(retryRes.status).toBe(200);
      order = await prisma.salesOrder.findUnique({ where: { id: soRes.body.id } });
      expect(order!.status).toBe("APPROVED"); // back to normal — no longer on hold
    });

    it("captures a real reason on FAILED and auto-clears it once the line recovers to a non-problem status", async () => {
      const soRes = await req().post("/sales-orders").send({
        customerId, dueDate: "2026-12-01", value: 900, priority: 0,
        externalOrderId: `SO-REASON-${suffix}`, fulfillmentType: "MTS", status: "APPROVED", currency: "INR",
      });
      createdSalesOrderIds.push(soRes.body.id);
      const fRes = await req().post(`/sales-orders/${soRes.body.id}/fulfillment`).send({
        productId, productName: "Test Widget", quantity: 5, unitPrice: 900,
        strategy: "MTS", lines: [{ sourceType: "STOCK", quantity: 5 }],
      });
      const lineId = fRes.body.fulfillmentLines[0].id;

      const failRes = await req().patch(`/fulfillment-lines/${lineId}`).send({
        status: "FAILED", reason: "Stock reservation shortfall: 5 required, 0 available",
      });
      expect(failRes.status).toBe(200);
      expect(failRes.body.reason).toBe("Stock reservation shortfall: 5 required, 0 available");
      let line = await prisma.fulfillmentLine.findUnique({ where: { id: lineId } });
      expect(line!.reason).toBe("Stock reservation shortfall: 5 required, 0 available");

      // Retry to a non-problem status with no explicit reason — the stale
      // failure reason must not survive the recovery.
      const retryRes = await req().patch(`/fulfillment-lines/${lineId}`).send({ status: "PENDING" });
      expect(retryRes.status).toBe(200);
      expect(retryRes.body.reason).toBeNull();
      line = await prisma.fulfillmentLine.findUnique({ where: { id: lineId } });
      expect(line!.reason).toBeNull();
    });

    it("ON_HOLD also captures a real reason", async () => {
      const soRes = await req().post("/sales-orders").send({
        customerId, dueDate: "2026-12-01", value: 900, priority: 0,
        externalOrderId: `SO-HOLD-REASON-${suffix}`, fulfillmentType: "MTS", status: "APPROVED", currency: "INR",
      });
      createdSalesOrderIds.push(soRes.body.id);
      const fRes = await req().post(`/sales-orders/${soRes.body.id}/fulfillment`).send({
        productId, productName: "Test Widget", quantity: 5, unitPrice: 900,
        strategy: "MTS", lines: [{ sourceType: "STOCK", quantity: 5 }],
      });
      const lineId = fRes.body.fulfillmentLines[0].id;

      const holdRes = await req().patch(`/fulfillment-lines/${lineId}`).send({
        status: "ON_HOLD", reason: "Awaiting planner review",
      });
      expect(holdRes.status).toBe(200);
      expect(holdRes.body.reason).toBe("Awaiting planner review");
    });
  });

  describe("unsupported fulfillment strategy (TRANSFER) — architecturally reserved, not fabricated", () => {
    it("accepts TRANSFER as a valid sourceType (the enum slot exists) without any execution document ever being fabricated for it", async () => {
      // Real finding: FulfillmentStrategy (the plan-level enum) has no
      // TRANSFER value at all — nothing in the current system (not even
      // fulfillment_agent's own schema) ever proposes a plan whose overall
      // strategy is "transfer"; only FulfillmentSourceType (the per-line
      // enum) reserves the slot. So the plan-level fields below stay a
      // real, valid strategy (HYBRID is as good as any placeholder) — this
      // test's actual subject is the line-level sourceType acceptance.
      const soRes = await req().post("/sales-orders").send({
        customerId, dueDate: "2026-12-01", value: 900, priority: 0,
        externalOrderId: `SO-TRANSFER-${suffix}`, fulfillmentType: "HYBRID", status: "APPROVED", currency: "INR",
      });
      createdSalesOrderIds.push(soRes.body.id);
      const res = await req().post(`/sales-orders/${soRes.body.id}/fulfillment`).send({
        productId, productName: "Test Widget", quantity: 5, unitPrice: 900,
        strategy: "HYBRID", lines: [{ sourceType: "TRANSFER", quantity: 5 }],
      });
      expect(res.status).toBe(201);

      // No TransferOrder model exists anywhere in this schema — confirming
      // there is nothing to fabricate a link to; productionOrderId and
      // executionReference both stay null until real transfer support exists.
      const line = await prisma.fulfillmentLine.findUnique({ where: { id: res.body.fulfillmentLines[0].id } });
      expect(line!.productionOrderId).toBeNull();
      expect(line!.executionReference).toBeNull();
      expect(line!.status).toBe("PENDING"); // never silently marked FULFILLED
    });
  });

  // Concurrency hardening (agreed with the user): the previous PATCH
  // implementation read the FulfillmentLine via a plain findUnique OUTSIDE
  // any transaction, then validated and wrote separately — a genuine TOCTOU
  // race where two near-simultaneous requests could both read PENDING,
  // both validate PENDING -> ALLOCATED as legal, and both write, silently
  // losing one update. Every test below fires real concurrent requests via
  // Promise.all (never sequential calls dressed up as "concurrency") against
  // the real running app + real Postgres, and asserts on the actually
  // persisted row afterward — not just on which HTTP response looked right.
  describe("concurrency hardening — atomic FulfillmentLine transitions", () => {
    async function freshStockLine(qty = 5): Promise<{ salesOrderId: string; lineId: string }> {
      const soRes = await req().post("/sales-orders").send({
        customerId, dueDate: "2026-12-01", value: qty * 900, priority: 0,
        externalOrderId: `SO-CONC-${randomUUID().slice(0, 8)}`, fulfillmentType: "MTS", status: "APPROVED", currency: "INR",
      });
      createdSalesOrderIds.push(soRes.body.id);
      const fRes = await req().post(`/sales-orders/${soRes.body.id}/fulfillment`).send({
        productId, productName: "Test Widget", quantity: qty, unitPrice: 900,
        strategy: "MTS", lines: [{ sourceType: "STOCK", quantity: qty }],
      });
      return { salesOrderId: soRes.body.id, lineId: fRes.body.fulfillmentLines[0].id };
    }

    async function freshProductionLine(qty = 5): Promise<{ salesOrderId: string; lineId: string }> {
      const soRes = await req().post("/sales-orders").send({
        customerId, dueDate: "2026-12-01", value: qty * 900, priority: 0,
        externalOrderId: `SO-CONC-${randomUUID().slice(0, 8)}`, fulfillmentType: "MTO", status: "APPROVED", currency: "INR",
      });
      createdSalesOrderIds.push(soRes.body.id);
      const fRes = await req().post(`/sales-orders/${soRes.body.id}/fulfillment`).send({
        productId, productName: "Test Widget", quantity: qty, unitPrice: 900,
        strategy: "MTO", lines: [{ sourceType: "PRODUCTION", quantity: qty }],
      });
      return { salesOrderId: soRes.body.id, lineId: fRes.body.fulfillmentLines[0].id };
    }

    it("TEST 1 — same transition fired concurrently: exactly one succeeds, the other gets 409, final state is ALLOCATED", async () => {
      const { lineId } = await freshStockLine();

      const [a, b] = await Promise.all([
        req().patch(`/fulfillment-lines/${lineId}`).send({ status: "ALLOCATED" }),
        req().patch(`/fulfillment-lines/${lineId}`).send({ status: "ALLOCATED" }),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 409]); // exactly one winner, one conflict — never [200, 200]

      const inDb = await prisma.fulfillmentLine.findUnique({ where: { id: lineId } });
      expect(inDb!.status).toBe("ALLOCATED"); // real committed final state, not corrupted
    });

    it("TEST 2 — competing transitions fired concurrently: one valid state wins, the loser is re-validated against the NEW state, not the stale one", async () => {
      const { lineId } = await freshStockLine();

      const [allocated, cancelled] = await Promise.all([
        req().patch(`/fulfillment-lines/${lineId}`).send({ status: "ALLOCATED" }),
        req().patch(`/fulfillment-lines/${lineId}`).send({ status: "CANCELLED" }),
      ]);

      // Whichever transaction's row lock is granted first commits PENDING
      // -> its target status; the second then sees that COMMITTED state
      // (never the original PENDING) when it validates. Both orderings are
      // real, valid outcomes of this table: PENDING->ALLOCATED then
      // ALLOCATED->CANCELLED (both succeed, chained), or PENDING->CANCELLED
      // first (winner) then CANCELLED->ALLOCATED (loser: CANCELLED is
      // terminal, so this one must be rejected). What must NEVER happen is
      // both requests validating against PENDING and both succeeding.
      const results = [
        { label: "ALLOCATED", res: allocated },
        { label: "CANCELLED", res: cancelled },
      ];
      const succeeded = results.filter((r) => r.res.status === 200);
      const failed = results.filter((r) => r.res.status !== 200);
      expect(succeeded.length).toBeGreaterThanOrEqual(1); // the winner always succeeds
      for (const f of failed) {
        expect([400, 409]).toContain(f.res.status);
      }

      const inDb = await prisma.fulfillmentLine.findUnique({ where: { id: lineId } });
      // The final committed state is always one the transition table
      // actually allows from PENDING (or a valid chain from it) — never an
      // impossible or corrupted value.
      expect(["ALLOCATED", "CANCELLED"]).toContain(inDb!.status);
      if (succeeded.length === 2) {
        // Chained case: PENDING -> ALLOCATED -> CANCELLED (or vice versa is
        // impossible since CANCELLED is terminal) — only the ALLOCATED-
        // first ordering can produce two winners.
        expect(inDb!.status).toBe("CANCELLED");
      }
    });

    it("TEST 3 — sequential valid transitions all succeed: PENDING -> ALLOCATED -> IN_PROGRESS -> FULFILLED", async () => {
      const { lineId } = await freshStockLine();

      for (const status of ["ALLOCATED", "IN_PROGRESS", "FULFILLED"]) {
        const res = await req().patch(`/fulfillment-lines/${lineId}`).send({ status });
        expect(res.status).toBe(200);
      }

      const inDb = await prisma.fulfillmentLine.findUnique({ where: { id: lineId } });
      expect(inDb!.status).toBe("FULFILLED");
    });

    it("TEST 4 — invalid transition is still rejected under the new locked path: FULFILLED -> IN_PROGRESS", async () => {
      const { lineId } = await freshStockLine();
      await req().patch(`/fulfillment-lines/${lineId}`).send({ status: "ALLOCATED" });
      await req().patch(`/fulfillment-lines/${lineId}`).send({ status: "FULFILLED" });

      const res = await req().patch(`/fulfillment-lines/${lineId}`).send({ status: "IN_PROGRESS" });
      expect(res.status).toBe(400);

      const inDb = await prisma.fulfillmentLine.findUnique({ where: { id: lineId } });
      expect(inDb!.status).toBe("FULFILLED"); // unchanged
    });

    it("TEST 5 — concurrent execution linkage: two different ProductionOrders race for the same line, only one wins, no overwrite", async () => {
      const { lineId } = await freshProductionLine();
      const orderA = await req().post("/orders").send({ plantId, productId, quantity: 5 });
      const orderB = await req().post("/orders").send({ plantId, productId, quantity: 5 });
      createdProductionOrderIds.push(orderA.body.id, orderB.body.id);

      const [a, b] = await Promise.all([
        req().patch(`/fulfillment-lines/${lineId}`).send({ productionOrderId: orderA.body.id }),
        req().patch(`/fulfillment-lines/${lineId}`).send({ productionOrderId: orderB.body.id }),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 400]); // exactly one linkage wins

      const inDb = await prisma.fulfillmentLine.findUnique({ where: { id: lineId } });
      // The committed link is real and is ONE of the two real ProductionOrders
      // — never null, never both, never corrupted.
      expect([orderA.body.id, orderB.body.id]).toContain(inDb!.productionOrderId);
    });

    it("TEST 6 — SalesOrder status stays exactly consistent with the final committed fulfillment states after concurrent updates", async () => {
      // A real HYBRID order — two independent lines — updated concurrently,
      // both racing to their own terminal FULFILLED state.
      const soRes = await req().post("/sales-orders").send({
        customerId, dueDate: "2026-12-01", value: 9000, priority: 0,
        externalOrderId: `SO-CONC-${randomUUID().slice(0, 8)}`, fulfillmentType: "HYBRID", status: "APPROVED", currency: "INR",
      });
      createdSalesOrderIds.push(soRes.body.id);
      const fRes = await req().post(`/sales-orders/${soRes.body.id}/fulfillment`).send({
        productId, productName: "Test Widget", quantity: 10, unitPrice: 900,
        strategy: "HYBRID", lines: [{ sourceType: "STOCK", quantity: 6 }, { sourceType: "PRODUCTION", quantity: 4 }],
      });
      const stockLineId = fRes.body.fulfillmentLines.find((l: { sourceType: string }) => l.sourceType === "STOCK").id;
      const productionLineId = fRes.body.fulfillmentLines.find((l: { sourceType: string }) => l.sourceType === "PRODUCTION").id;

      // Drive both lines to FULFILLED via real concurrent request pairs at
      // each step — not sequential calls dressed up as concurrency.
      await Promise.all([
        req().patch(`/fulfillment-lines/${stockLineId}`).send({ status: "ALLOCATED" }),
        req().patch(`/fulfillment-lines/${productionLineId}`).send({ status: "EXECUTION_CREATED" }),
      ]);
      await Promise.all([
        req().patch(`/fulfillment-lines/${stockLineId}`).send({ status: "FULFILLED" }),
        req().patch(`/fulfillment-lines/${productionLineId}`).send({ status: "FULFILLED" }),
      ]);

      const [stockLine, productionLine, order] = await Promise.all([
        prisma.fulfillmentLine.findUnique({ where: { id: stockLineId } }),
        prisma.fulfillmentLine.findUnique({ where: { id: productionLineId } }),
        prisma.salesOrder.findUnique({ where: { id: soRes.body.id } }),
      ]);
      expect(stockLine!.status).toBe("FULFILLED");
      expect(productionLine!.status).toBe("FULFILLED");
      // Exactly matches deriveSalesOrderStatus's rule for "every line
      // FULFILLED" — never left at a stale PARTIALLY_FULFILLED because a
      // concurrent recompute read an incomplete line set.
      expect(order!.status).toBe("COMPLETED");
    });
  });

  // Stage 01 (Fail Loud, Fail Closed) — ARCHITECTURE_BASELINE.md §5/§6/§11:
  // a Kafka publish failure after a committed write used to surface as an
  // unguarded HTTP 500, indistinguishable from the write itself failing.
  describe("Stage 01 — downstream sync failure after a committed write", () => {
    afterEach(() => {
      // Restores to the real publishTracked implementation this mock was
      // created with — every other test in this file (and the next test
      // in this block) keeps exercising the real Kafka publish path.
      vi.mocked(shared.publishTracked).mockRestore();
    });

    it("TEST 1 — a downstream publish failure on POST /orders is not silently swallowed: it's reported on the response and the order still exists", async () => {
      const syncError = new shared.DownstreamSyncError({
        operation: "POST /orders",
        target: "kafka:orders.production.created",
        entityId: "will-be-overwritten",
        cause: new Error("simulated broker unavailable"),
      });
      vi.mocked(shared.publishTracked).mockResolvedValueOnce(syncError);

      const res = await req().post("/orders").send({ plantId, productId, quantity: 5 });

      // TEST 2 — the DB write is NOT pretended to have rolled back: 201
      // Created, the real order id, not a 500.
      expect(res.status).toBe(201);
      expect(res.body.id).toBeTruthy();
      createdProductionOrderIds.push(res.body.id);

      // The failure is visible on the response, not hidden.
      expect(res.body.syncWarning).toContain("simulated broker unavailable");

      // And the write really did commit — proven independently of the
      // response body, directly against Postgres.
      const persisted = await prisma.productionOrder.findUnique({ where: { id: res.body.id } });
      expect(persisted).not.toBeNull();
      expect(persisted!.plantId).toBe(plantId);
    });

    it("a downstream publish failure on PATCH /orders/:id is reported, not swallowed, and the update still commits", async () => {
      const createRes = await req().post("/orders").send({ plantId, productId, quantity: 3 });
      createdProductionOrderIds.push(createRes.body.id);

      const syncError = new shared.DownstreamSyncError({
        operation: "PATCH /orders/:id",
        target: "kafka:orders.production.updated",
        entityId: createRes.body.id,
        cause: new Error("simulated broker unavailable"),
      });
      vi.mocked(shared.publishTracked).mockResolvedValueOnce(syncError);

      const res = await req().patch(`/orders/${createRes.body.id}`).send({ status: "RELEASED" });

      expect(res.status).toBe(200);
      expect(res.body.syncWarning).toContain("simulated broker unavailable");

      const persisted = await prisma.productionOrder.findUnique({ where: { id: createRes.body.id } });
      expect(persisted!.status).toBe("RELEASED");
    });

    it("a successful publish still returns the plain order with no syncWarning (no regression on the happy path)", async () => {
      const res = await req().post("/orders").send({ plantId, productId, quantity: 2 });
      createdProductionOrderIds.push(res.body.id);

      expect(res.status).toBe(201);
      expect(res.body.syncWarning).toBeUndefined();
    });
  });

  // Stage 03C Part B: POST /orders is the agent-orchestrator's real
  // production-preview call (relayed through APS Platform's apsAgent.ts) —
  // a timeout/retry of it used to be able to create two ProductionOrder
  // rows for the same logical preview, since ProductionOrder has no
  // uniqueness constraint of its own beyond `id` (confirmed against
  // packages/domain/prisma/schema.prisma before implementing). Reuses the
  // exact same claim-first IdempotencyKey mechanism POST /sales-orders
  // already uses (see the "Stage 03 atomic order+fulfillment creation"
  // describe block below) — no second idempotency implementation.
  describe("Stage 03C Part B — POST /orders idempotency", () => {
    it("same preview + same Idempotency-Key, called again as if the first response never arrived: returns the exact same ProductionOrder, never a second row", async () => {
      const idempotencyKey = `prod-order-replay-${suffix}`;
      const body = { plantId, productId, quantity: 17 };

      const first = await req().post("/orders").set("Idempotency-Key", idempotencyKey).send(body);
      expect(first.status).toBe(201);
      createdProductionOrderIds.push(first.body.id);

      const retried = await req().post("/orders").set("Idempotency-Key", idempotencyKey).send(body);
      expect(retried.status).toBe(201);
      expect(retried.body.id).toBe(first.body.id);

      const rows = await prisma.productionOrder.findMany({ where: { plantId, productId, quantity: 17 } });
      expect(rows.length).toBe(1);
    });

    it("concurrent requests for the same preview under the same Idempotency-Key never create two distinct ProductionOrder rows", async () => {
      const idempotencyKey = `prod-order-concurrent-${suffix}`;
      const body = { plantId, productId, quantity: 23 };

      const [a, b] = await Promise.all([
        req().post("/orders").set("Idempotency-Key", idempotencyKey).send(body),
        req().post("/orders").set("Idempotency-Key", idempotencyKey).send(body),
      ]);

      // Same real guarantee as the analogous POST /sales-orders race test:
      // under genuine concurrency either response may legitimately be a
      // 409 ("already in progress") — what must never happen is two
      // different real orders for one logical preview.
      const created = [a, b].filter((r) => r.status === 201);
      expect(created.length).toBeGreaterThanOrEqual(1);
      const distinctIds = new Set(created.map((r) => r.body.id));
      expect(distinctIds.size).toBe(1);
      for (const id of distinctIds) createdProductionOrderIds.push(id);

      const rows = await prisma.productionOrder.findMany({ where: { plantId, productId, quantity: 23 } });
      expect(rows.length).toBe(1);
    });

    it("two genuinely different production previews (different Idempotency-Keys) are never conflated into one order", async () => {
      const first = await req()
        .post("/orders")
        .set("Idempotency-Key", `prod-order-distinct-a-${suffix}`)
        .send({ plantId, productId, quantity: 31 });
      const second = await req()
        .post("/orders")
        .set("Idempotency-Key", `prod-order-distinct-b-${suffix}`)
        .send({ plantId, productId, quantity: 31 });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(first.body.id).not.toBe(second.body.id);
      createdProductionOrderIds.push(first.body.id, second.body.id);

      const rows = await prisma.productionOrder.findMany({ where: { plantId, productId, quantity: 31 } });
      expect(rows.length).toBe(2);
    });

    it("a caller that sends no Idempotency-Key header is completely unaffected: every identical call still creates its own new order", async () => {
      const a = await req().post("/orders").send({ plantId, productId, quantity: 7 });
      const b = await req().post("/orders").send({ plantId, productId, quantity: 7 });

      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(a.body.id).not.toBe(b.body.id);
      createdProductionOrderIds.push(a.body.id, b.body.id);
    });

    it("timeout/retry-shaped: a request that fails validation under an Idempotency-Key is not cached, so a genuine retry with corrected input succeeds and creates the order", async () => {
      const idempotencyKey = `prod-order-retry-after-failure-${suffix}`;

      const failed = await req()
        .post("/orders")
        .set("Idempotency-Key", idempotencyKey)
        .send({ plantId: "does-not-exist", productId, quantity: 9 });
      expect(failed.status).toBe(404);

      const retried = await req().post("/orders").set("Idempotency-Key", idempotencyKey).send({ plantId, productId, quantity: 9 });
      expect(retried.status).toBe(201);
      createdProductionOrderIds.push(retried.body.id);

      const persisted = await prisma.productionOrder.findUnique({ where: { id: retried.body.id } });
      expect(persisted).not.toBeNull();
    });
  });
});

// Stage 02 (Tenant Isolation + Service Identity) — ARCHITECTURE_BASELINE.md
// Part H/I: a real, concrete two-enterprise scenario. Every test here
// proves an actual domain operation is prevented or allowed — never just
// that middleware ran — by checking real HTTP responses and, where it
// matters, real Postgres state.
describe("order-service — Stage 02 tenant isolation", () => {
  const suffix = randomUUID().slice(0, 8);
  let enterpriseAId: string, enterpriseBId: string;
  let plantAId: string, plantBId: string;
  let productId: string;
  let customerAId: string, customerBId: string;
  let salesOrderAId: string, salesOrderBId: string;
  const createdEnterpriseIds: string[] = [];
  const createdProductionOrderIds: string[] = [];

  async function makeTenant(label: string) {
    const enterprise = await prisma.enterprise.create({
      data: { name: `test-tenant-${label}-${suffix}`, timezone: "UTC", currency: "USD" },
    });
    createdEnterpriseIds.push(enterprise.id);
    const site = await prisma.site.create({ data: { enterpriseId: enterprise.id, name: `site-${label}-${suffix}`, timezone: "UTC" } });
    const plant = await prisma.plant.create({ data: { siteId: site.id, code: `PLANT-${label}-${suffix}`, type: "DISCRETE", capacityUnit: "hours" } });
    return { enterpriseId: enterprise.id, plantId: plant.id };
  }

  beforeAll(async () => {
    const a = await makeTenant("A");
    enterpriseAId = a.enterpriseId;
    plantAId = a.plantId;
    const b = await makeTenant("B");
    enterpriseBId = b.enterpriseId;
    plantBId = b.plantId;

    const product = await prisma.product.create({ data: { sku: `SKU-S02-${suffix}`, family: "Test", uom: "EA", leadTimeDays: 1 } });
    productId = product.id;

    // Enterprise A's own real Customer + SalesOrder.
    const custA = await req(enterpriseAId).post("/customers").send({ name: `Customer A ${suffix}`, tier: "STANDARD", slaDays: 14, penaltyPerDay: 0 });
    customerAId = custA.body.id;
    const soA = await req(enterpriseAId).post("/sales-orders").send({
      customerId: customerAId, dueDate: "2026-12-01", value: 1000, priority: 0,
      externalOrderId: `SO-A-${suffix}`, currency: "USD",
    });
    salesOrderAId = soA.body.id;

    // Enterprise B's own real Customer + SalesOrder — fully independent.
    const custB = await req(enterpriseBId).post("/customers").send({ name: `Customer B ${suffix}`, tier: "STANDARD", slaDays: 14, penaltyPerDay: 0 });
    customerBId = custB.body.id;
    const soB = await req(enterpriseBId).post("/sales-orders").send({
      customerId: customerBId, dueDate: "2026-12-01", value: 2000, priority: 0,
      externalOrderId: `SO-B-${suffix}`, currency: "USD",
    });
    salesOrderBId = soB.body.id;
  });

  afterAll(async () => {
    await prisma.productionOrder.deleteMany({ where: { id: { in: createdProductionOrderIds } } });
    await prisma.salesOrder.deleteMany({ where: { id: { in: [salesOrderAId, salesOrderBId] } } });
    await prisma.customer.deleteMany({ where: { id: { in: [customerAId, customerBId] } } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.plant.deleteMany({ where: { id: { in: [plantAId, plantBId] } } });
    await prisma.site.deleteMany({ where: { enterpriseId: { in: createdEnterpriseIds } } });
    await prisma.enterprise.deleteMany({ where: { id: { in: createdEnterpriseIds } } });
    await prisma.$disconnect();
  });

  it("TEST 1 — Enterprise A can read its own Customer", async () => {
    const res = await req(enterpriseAId).get(`/customers?name=${encodeURIComponent(`Customer A ${suffix}`)}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(customerAId);
  });

  it("TEST 2 / TEST 9 — Enterprise A cannot read Enterprise B's Customer by changing the customer id (A -> B customer read)", async () => {
    // Same name search, but as Enterprise B's own customer — proves the
    // scope is real enterprise ownership, not just a name match.
    const res = await req(enterpriseAId).get(`/customers?name=${encodeURIComponent(`Customer B ${suffix}`)}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0); // not found, not leaked
  });

  it("TEST 3 — Enterprise A cannot update Enterprise B's SalesOrder by changing the order id (A -> B order update), and A -> A still works", async () => {
    // A -> B fulfillment create (an update-shaped mutation on B's order) must fail.
    const attack = await req(enterpriseAId).post(`/sales-orders/${salesOrderBId}/fulfillment`).send({
      productName: "Widget", quantity: 1, unitPrice: 10, strategy: "MTS",
      lines: [{ sourceType: "STOCK", quantity: 1 }],
    });
    expect(attack.status).toBe(404);

    // A -> A on its own order must still succeed (no over-broad lockout).
    const legit = await req(enterpriseAId).post(`/sales-orders/${salesOrderAId}/fulfillment`).send({
      productName: "Widget", quantity: 1, unitPrice: 10, strategy: "MTS",
      lines: [{ sourceType: "STOCK", quantity: 1 }],
    });
    expect(legit.status).toBe(201);

    // A -> B order read (fulfillment GET) must also fail.
    const readAttack = await req(enterpriseAId).get(`/sales-orders/${salesOrderBId}/fulfillment`);
    expect(readAttack.status).toBe(404);
    // B -> B read of its own order (created above, no fulfillment on it
    // yet) must still succeed.
    const bOwnRead = await req(enterpriseBId).get(`/sales-orders/${salesOrderBId}/fulfillment`);
    expect(bOwnRead.status).toBe(200);
  });

  it("TEST 9 (ProductionOrder) — Enterprise A cannot read/update/delete Enterprise B's ProductionOrder even knowing its real id", async () => {
    const bOrderRes = await req(enterpriseBId).post("/orders").send({ plantId: plantBId, productId, quantity: 5 });
    expect(bOrderRes.status).toBe(201);
    const bOrderId = bOrderRes.body.id;
    createdProductionOrderIds.push(bOrderId);

    const readAttack = await req(enterpriseAId).get(`/orders/${bOrderId}`);
    expect(readAttack.status).toBe(404);

    const updateAttack = await req(enterpriseAId).patch(`/orders/${bOrderId}`).send({ status: "RELEASED" });
    expect(updateAttack.status).toBe(404);
    // Proves the update really didn't happen, not just that the response said 404.
    const stillPlanned = await prisma.productionOrder.findUnique({ where: { id: bOrderId } });
    expect(stillPlanned!.status).toBe("PLANNED");

    const deleteAttack = await req(enterpriseAId).delete(`/orders/${bOrderId}`);
    expect(deleteAttack.status).toBe(404);
    const stillExists = await prisma.productionOrder.findUnique({ where: { id: bOrderId } });
    expect(stillExists).not.toBeNull();

    // A cannot even create a ProductionOrder against B's plant.
    const crossPlant = await req(enterpriseAId).post("/orders").send({ plantId: plantBId, productId, quantity: 1 });
    expect(crossPlant.status).toBe(404);

    // B -> B still works normally.
    const bOwnRead = await req(enterpriseBId).get(`/orders/${bOrderId}`);
    expect(bOwnRead.status).toBe(200);
  });

  it("TEST 5 — a request with no identity assertion at all is rejected", async () => {
    const res = await request(app)
      .get(`/customers?name=${encodeURIComponent(`Customer A ${suffix}`)}`)
      .set(AUTH_HEADER); // real internal token, deliberately no x-identity-assertion
    expect(res.status).toBe(401);
  });

  it("TEST 6 — a forged enterprise header cannot override the verified assertion's real enterprise", async () => {
    // The real contract here is simpler and stronger than header-stripping:
    // this server never reads x-forwarded-enterprise/x-forwarded-role at
    // all, only the signed assertion's own claims — so setting one is a
    // no-op, not a partially-trusted override. Proven by the actual
    // domain result (B's data stays invisible), not by inspecting what
    // the middleware parsed.
    const res = await request(app)
      .get(`/customers?name=${encodeURIComponent(`Customer B ${suffix}`)}`)
      .set(AUTH_HEADER)
      .set(identityHeader(enterpriseAId)) // genuinely authenticated as A
      .set("x-forwarded-enterprise", enterpriseBId) // forged, must be ignored
      .set("x-forwarded-role", "OWNER"); // forged, must be ignored
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0); // still can't see B's customer
  });

  it("TEST 7 — an expired identity assertion is rejected", async () => {
    const expiredToken = shared.signIdentityAssertion(
      { sub: "test-user", type: "user", role: "PLANNER", enterpriseId: enterpriseAId, aud: "aps-internal" },
      process.env.INTERNAL_SERVICE_TOKEN ?? "",
      -10 // already expired 10 seconds ago
    );
    const res = await request(app)
      .get(`/customers?name=${encodeURIComponent(`Customer A ${suffix}`)}`)
      .set(AUTH_HEADER)
      .set({ "x-identity-assertion": expiredToken });
    expect(res.status).toBe(401);
  });

  it("an identity assertion minted for a different audience is rejected (prevents replaying a token meant for a different context)", async () => {
    const wrongAudience = shared.signIdentityAssertion(
      { sub: "test-user", type: "user", role: "PLANNER", enterpriseId: enterpriseAId, aud: "some-other-context" },
      process.env.INTERNAL_SERVICE_TOKEN ?? ""
    );
    const res = await request(app)
      .get(`/customers?name=${encodeURIComponent(`Customer A ${suffix}`)}`)
      .set(AUTH_HEADER)
      .set({ "x-identity-assertion": wrongAudience });
    expect(res.status).toBe(401);
  });

  it("TEST 8 — a legitimate, correctly-scoped request still works end to end", async () => {
    const res = await req(enterpriseBId).get(`/customers?name=${encodeURIComponent(`Customer B ${suffix}`)}`);
    expect(res.status).toBe(200);
    expect(res.body[0].id).toBe(customerBId);
  });
});

// Stage 03A/B (One True Order → Fulfillment → Production Loop) — the new
// atomic POST /sales-orders path (optional `lines`) and its Idempotency-Key
// support. Built and tested here in isolation: no caller changes yet
// (agent-orchestrator/setup-import.ts still call the old 2-request
// sequence) — this only proves the new primitive itself is correct before
// anything is migrated onto it.
describe("order-service — Stage 03 atomic order+fulfillment creation", () => {
  const suffix = randomUUID().slice(0, 8);
  let enterpriseId: string;
  let customerId: string;
  const createdSalesOrderIds: string[] = [];

  beforeAll(async () => {
    const enterprise = await prisma.enterprise.create({
      data: { name: `test-stage03-${suffix}`, timezone: "UTC", currency: "USD" },
    });
    enterpriseId = enterprise.id;
    const customer = await prisma.customer.create({
      data: { name: `Customer S03 ${suffix}`, tier: "STANDARD", slaDays: 14, penaltyPerDay: 0, enterpriseId },
    });
    customerId = customer.id;
  });

  afterAll(async () => {
    await prisma.fulfillmentLine.deleteMany({ where: { fulfillmentPlan: { orderLine: { orderId: { in: createdSalesOrderIds } } } } });
    await prisma.fulfillmentPlan.deleteMany({ where: { orderLine: { orderId: { in: createdSalesOrderIds } } } });
    await prisma.orderLine.deleteMany({ where: { orderId: { in: createdSalesOrderIds } } });
    await prisma.idempotencyKey.deleteMany({ where: { enterpriseId } });
    await prisma.salesOrder.deleteMany({ where: { id: { in: createdSalesOrderIds } } });
    await prisma.customer.deleteMany({ where: { id: customerId } });
    await prisma.enterprise.deleteMany({ where: { id: enterpriseId } });
    await prisma.$disconnect();
  });

  function atomicOrderBody(externalOrderId: string, quantity = 10) {
    return {
      customerId, dueDate: "2026-12-01", value: 1000, priority: 0, currency: "USD", externalOrderId,
      productName: "Widget", quantity, unitPrice: 100, strategy: "MTS",
      lines: [{ sourceType: "STOCK", quantity }],
    };
  }

  it("1/2/3 — one request creates exactly one SalesOrder with its OrderLine/FulfillmentPlan/FulfillmentLine atomically", async () => {
    const res = await req(enterpriseId).post("/sales-orders").send(atomicOrderBody(`SO-S03-${suffix}-1`));
    expect(res.status).toBe(201);
    createdSalesOrderIds.push(res.body.id);

    const persisted = await prisma.salesOrder.findUnique({
      where: { id: res.body.id },
      include: { orderLines: { include: { fulfillmentPlan: { include: { lines: true } } } } },
    });
    expect(persisted).not.toBeNull();
    expect(persisted!.orderLines).toHaveLength(1);
    expect(persisted!.orderLines[0].fulfillmentPlan).not.toBeNull();
    expect(persisted!.orderLines[0].fulfillmentPlan!.lines).toHaveLength(1);
    expect(persisted!.orderLines[0].fulfillmentPlan!.lines[0].sourceType).toBe("STOCK");
  });

  it("5 — a failed/invalid request leaves no partial SalesOrder/OrderLine/FulfillmentPlan/FulfillmentLine rows", async () => {
    const externalOrderId = `SO-S03-${suffix}-invalid`;
    const body = atomicOrderBody(externalOrderId, 10);
    // Lines sum (10) deliberately mismatched against the order quantity (99)
    // to trigger validateFulfillmentLines' rejection AFTER body construction
    // but BEFORE the transaction opens.
    (body as { quantity: number }).quantity = 99;

    const res = await req(enterpriseId).post("/sales-orders").send(body);
    expect(res.status).toBe(400);

    const persisted = await prisma.salesOrder.findFirst({ where: { externalOrderId, enterpriseId } });
    expect(persisted).toBeNull(); // no partial SalesOrder at all — rejected before the transaction
  });

  it("4 — repeating the same request with the same Idempotency-Key returns the original result, not a duplicate", async () => {
    const externalOrderId = `SO-S03-${suffix}-idem`;
    const idempotencyKey = `idem-${suffix}-1`;
    const body = atomicOrderBody(externalOrderId);

    const first = await req(enterpriseId).post("/sales-orders").set("Idempotency-Key", idempotencyKey).send(body);
    expect(first.status).toBe(201);
    createdSalesOrderIds.push(first.body.id);

    const second = await req(enterpriseId).post("/sales-orders").set("Idempotency-Key", idempotencyKey).send(body);
    expect(second.status).toBe(201);
    // The EXACT original result, not a recomputed (even if superficially
    // identical) one — proves replay, not re-execution.
    expect(second.body.id).toBe(first.body.id);

    const matching = await prisma.salesOrder.findMany({ where: { externalOrderId, enterpriseId } });
    expect(matching).toHaveLength(1); // only ONE real SalesOrder exists, despite 2 requests
  });

  it("Part A — the same Idempotency-Key reused for a genuinely different request body is rejected (409), never silently replayed", async () => {
    const idempotencyKey = `idem-mismatch-${suffix}`;
    const firstBody = atomicOrderBody(`SO-S03-${suffix}-mismatch-1`);
    const differentBody = atomicOrderBody(`SO-S03-${suffix}-mismatch-2`); // same key, different externalOrderId

    const first = await req(enterpriseId).post("/sales-orders").set("Idempotency-Key", idempotencyKey).send(firstBody);
    expect(first.status).toBe(201);
    createdSalesOrderIds.push(first.body.id);

    const second = await req(enterpriseId).post("/sales-orders").set("Idempotency-Key", idempotencyKey).send(differentBody);
    expect(second.status).toBe(409);

    // The mismatched request never ran — only the first order exists.
    const secondOrderExists = await prisma.salesOrder.findFirst({
      where: { externalOrderId: differentBody.externalOrderId, enterpriseId },
    });
    expect(secondOrderExists).toBeNull();
  });

  it("Part A — a failed request is not cached under its Idempotency-Key: retrying with a corrected body succeeds", async () => {
    const idempotencyKey = `idem-retry-after-failure-${suffix}`;
    const externalOrderId = `SO-S03-${suffix}-retry-after-failure`;
    const badBody = atomicOrderBody(externalOrderId, 10);
    (badBody as { quantity: number }).quantity = 99; // lines sum (10) != quantity (99) -> 400, never reaches the transaction

    const failed = await req(enterpriseId).post("/sales-orders").set("Idempotency-Key", idempotencyKey).send(badBody);
    expect(failed.status).toBe(400);

    // The SAME key, now with a corrected body, must be treated as a fresh
    // attempt — not rejected as "already used" and not replaying the
    // (never-cached) failure.
    const fixedBody = atomicOrderBody(externalOrderId, 10);
    const retried = await req(enterpriseId).post("/sales-orders").set("Idempotency-Key", idempotencyKey).send(fixedBody);
    expect(retried.status).toBe(201);
    createdSalesOrderIds.push(retried.body.id);

    const persisted = await prisma.salesOrder.findFirst({ where: { externalOrderId, enterpriseId } });
    expect(persisted).not.toBeNull();
  });

  it("a different Idempotency-Key creates a genuinely separate order (no false-positive idempotency)", async () => {
    const body1 = atomicOrderBody(`SO-S03-${suffix}-diffkey-1`);
    const body2 = atomicOrderBody(`SO-S03-${suffix}-diffkey-2`);

    const res1 = await req(enterpriseId).post("/sales-orders").set("Idempotency-Key", `key-a-${suffix}`).send(body1);
    const res2 = await req(enterpriseId).post("/sales-orders").set("Idempotency-Key", `key-b-${suffix}`).send(body2);
    createdSalesOrderIds.push(res1.body.id, res2.body.id);

    expect(res1.body.id).not.toBe(res2.body.id);
  });

  it("9 — two concurrent requests with the same Idempotency-Key cannot both create a real (distinct) order (claim-first race protection)", async () => {
    const idempotencyKey = `idem-concurrent-${suffix}`;
    const body = atomicOrderBody(`SO-S03-${suffix}-concurrent`);

    const [a, b] = await Promise.all([
      req(enterpriseId).post("/sales-orders").set("Idempotency-Key", idempotencyKey).send(body),
      req(enterpriseId).post("/sales-orders").set("Idempotency-Key", idempotencyKey).send(body),
    ]);

    // Two correct outcomes are possible depending on exact timing, and
    // both are acceptable: (a) one request wins the claim and the other,
    // arriving before the winner's result is recorded, gets 409; or
    // (b) the winner finishes first and the second request's claim
    // attempt finds an already-resolved result and replays it (also
    // 201). What must NEVER happen is two successful requests
    // disagreeing on which order this was.
    for (const r of [a, b]) expect([201, 409]).toContain(r.status);
    const successes = [a, b].filter((r) => r.status === 201);
    expect(successes.length).toBeGreaterThanOrEqual(1);
    const distinctIds = new Set(successes.map((r) => r.body.id));
    expect(distinctIds.size).toBe(1); // every 201 response agrees on the same real order
    createdSalesOrderIds.push(...distinctIds);

    const matching = await prisma.salesOrder.findMany({ where: { externalOrderId: body.externalOrderId, enterpriseId } });
    expect(matching).toHaveLength(1); // never two real orders from the race
  });

  it("omitting `lines` preserves the exact pre-Stage-03 behavior — SalesOrder only, no fulfillment plan", async () => {
    const res = await req(enterpriseId).post("/sales-orders").send({
      customerId, dueDate: "2026-12-01", value: 500, priority: 0, currency: "USD",
      externalOrderId: `SO-S03-${suffix}-nolines`,
    });
    expect(res.status).toBe(201);
    createdSalesOrderIds.push(res.body.id);

    const persisted = await prisma.salesOrder.findUnique({
      where: { id: res.body.id },
      include: { orderLines: true },
    });
    expect(persisted!.orderLines).toHaveLength(0);
  });
});

// Phase 14 (Promise Risk & Decision Inbox) — tests for the new
// GET /sales-orders/promises aggregation endpoint (src/promise-inbox.ts).
// Fully self-contained fixtures/cleanup (own tracking arrays, own
// afterAll) so this describe block never depends on ordering relative to
// its siblings above.
describe("GET /sales-orders/promises", () => {
  const suffix = randomUUID().slice(0, 8);
  let enterpriseId: string;
  let plantId: string;
  let productId: string;
  const salesOrderIds: string[] = [];
  const productionOrderIds: string[] = [];
  const customerIds: string[] = [];
  const agentPipelineRunIds: string[] = [];

  beforeAll(async () => {
    const enterprise = await prisma.enterprise.create({
      data: { name: `test-promise-inbox-${suffix}`, timezone: "UTC", currency: "USD" },
    });
    enterpriseId = enterprise.id;
    const site = await prisma.site.create({ data: { enterpriseId, name: `test-site-pi-${suffix}`, timezone: "UTC" } });
    const plant = await prisma.plant.create({ data: { siteId: site.id, code: `TEST-PI-${suffix}`, type: "DISCRETE", capacityUnit: "hours" } });
    plantId = plant.id;
    const product = await prisma.product.create({ data: { sku: `SKU-PI-${suffix}`, family: "Test", uom: "EA", leadTimeDays: 1 } });
    productId = product.id;
  });

  afterAll(async () => {
    await prisma.agentPipelineRun.deleteMany({ where: { id: { in: agentPipelineRunIds } } });
    await prisma.fulfillmentLine.deleteMany({ where: { fulfillmentPlan: { orderLine: { orderId: { in: salesOrderIds } } } } });
    await prisma.fulfillmentPlan.deleteMany({ where: { orderLine: { orderId: { in: salesOrderIds } } } });
    await prisma.orderLine.deleteMany({ where: { orderId: { in: salesOrderIds } } });
    await prisma.productionException.deleteMany({ where: { scheduledOperation: { productionOrderId: { in: productionOrderIds } } } });
    await prisma.scheduledOperation.deleteMany({ where: { productionOrderId: { in: productionOrderIds } } });
    await prisma.productionOrder.deleteMany({ where: { id: { in: productionOrderIds } } });
    await prisma.salesOrder.deleteMany({ where: { id: { in: salesOrderIds } } });
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
    await prisma.plant.deleteMany({ where: { id: plantId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.site.deleteMany({ where: { enterpriseId } });
    await prisma.enterprise.deleteMany({ where: { id: enterpriseId } });
  });

  // Builds one SalesOrder -> OrderLine -> FulfillmentPlan -> FulfillmentLine(s)
  // -> (optionally) ProductionOrder -> ScheduledOperation(s) tree, returning
  // the ids a test needs to assert against or attach an AgentPipelineRun to.
  async function makePromiseFixture(opts: {
    customerName: string;
    orderNumber: string;
    promisedDate: Date;
    lines: Array<{
      sourceType: "STOCK" | "PRODUCTION";
      quantity: number;
      promisedDate?: Date;
      // When sourceType is PRODUCTION: real ScheduledOperation rows to
      // create (end dates drive projectedDeliveryDate), or omit entirely
      // to simulate "MISSING" schedule evidence (a PRODUCTION leg with no
      // ops at all despite being RELEASED).
      scheduledOps?: Array<{ start: Date; end: Date; status?: "PLANNED" | "SCHEDULED" | "IN_PROGRESS" | "DONE" | "BLOCKED" }>;
      openExceptions?: number;
      productionOrderStatus?: "DRAFT" | "PLANNED" | "RELEASED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
    }>;
    priority?: number;
  }) {
    const customer = await prisma.customer.create({
      data: { name: opts.customerName, tier: "STANDARD", slaDays: 14, penaltyPerDay: 0, enterpriseId },
    });
    customerIds.push(customer.id);

    const salesOrder = await prisma.salesOrder.create({
      data: {
        customerId: customer.id,
        dueDate: opts.promisedDate,
        priority: opts.priority ?? 0,
        enterpriseId,
        orderNumber: opts.orderNumber,
        status: "APPROVED",
      },
    });
    salesOrderIds.push(salesOrder.id);

    const orderLine = await prisma.orderLine.create({
      data: { orderId: salesOrder.id, productId, productName: "Test Widget", quantity: opts.lines.reduce((s, l) => s + l.quantity, 0), unitPrice: 10 },
    });
    const fulfillmentPlan = await prisma.fulfillmentPlan.create({
      data: { orderLineId: orderLine.id, strategy: opts.lines.length > 1 ? "HYBRID" : opts.lines[0].sourceType === "STOCK" ? "MTS" : "MTO" },
    });

    const productionOrderIdsForLines: (string | null)[] = [];
    for (const line of opts.lines) {
      let productionOrderId: string | null = null;
      if (line.sourceType === "PRODUCTION") {
        const po = await prisma.productionOrder.create({
          data: {
            plantId,
            salesOrderId: salesOrder.id,
            productId,
            quantity: line.quantity,
            status: line.productionOrderStatus ?? "RELEASED",
            enterpriseId,
          },
        });
        productionOrderIds.push(po.id);
        productionOrderId = po.id;

        if (line.scheduledOps) {
          for (const op of line.scheduledOps) {
            const scheduledOp = await prisma.scheduledOperation.create({
              data: {
                productionOrderId: po.id,
                scheduledStart: op.start,
                scheduledEnd: op.end,
                status: op.status ?? "SCHEDULED",
              },
            });
            for (let i = 0; i < (line.openExceptions ?? 0); i++) {
              await prisma.productionException.create({
                data: { scheduledOperationId: scheduledOp.id, type: "MACHINE_BREAKDOWN", note: "test exception" },
              });
            }
          }
        }
      }
      productionOrderIdsForLines.push(productionOrderId);
      await prisma.fulfillmentLine.create({
        data: {
          fulfillmentPlanId: fulfillmentPlan.id,
          sourceType: line.sourceType,
          quantity: line.quantity,
          status: "EXECUTION_CREATED",
          promisedDate: line.promisedDate ?? opts.promisedDate,
          productionOrderId,
        },
      });
    }

    return { salesOrderId: salesOrder.id, customerId: customer.id, productionOrderIds: productionOrderIdsForLines };
  }

  it("classifies an order as BREACHED when the real projected delivery is after the promise", async () => {
    const now = new Date();
    const promisedDate = new Date(now.getTime() + 2 * 86_400_000); // +2 days
    const lateEnd = new Date(now.getTime() + 5 * 86_400_000); // +5 days, after the promise
    const { salesOrderId } = await makePromiseFixture({
      customerName: `Breached Co ${suffix}`,
      orderNumber: `PI-BREACH-${suffix}`,
      promisedDate,
      lines: [{ sourceType: "PRODUCTION", quantity: 5, scheduledOps: [{ start: now, end: lateEnd }] }],
    });

    const res = await req(enterpriseId).get("/sales-orders/promises").query({ limit: 200 });
    expect(res.status).toBe(200);
    const item = res.body.items.find((i: { salesOrderId: string }) => i.salesOrderId === salesOrderId);
    expect(item).toBeDefined();
    expect(item.riskStatus).toBe("BREACHED");
    expect(item.workflowStatus).toBe("NONE");
    expect(item.delayHours).toBeGreaterThan(0);
    expect(item.explanation).toMatch(/after the committed promise/);
    // Phase 15 (Promise Intelligence & Evidence Quality)
    expect(item.reasonCode).toBe("SCHEDULE_OVERRUN");
    expect(item.scheduleAsOf).not.toBeNull();
  });

  it("Phase 15 — a scheduled operation whose window already passed with no confirmation it started or finished is STALE evidence, not a trustworthy on-time/late signal", async () => {
    const now = new Date();
    const promisedDate = new Date(now.getTime() + 10 * 86_400_000); // comfortably in the future
    const overdueUnconfirmedEnd = new Date(now.getTime() - 2 * 86_400_000); // 2 days AGO, never confirmed
    const { salesOrderId } = await makePromiseFixture({
      customerName: `Stale Co ${suffix}`,
      orderNumber: `PI-STALE-${suffix}`,
      promisedDate,
      // status defaults to SCHEDULED in the fixture helper, and it never
      // sets actualEnd — exactly "never confirmed" real test data, not a
      // contrived flag.
      lines: [{ sourceType: "PRODUCTION", quantity: 2, scheduledOps: [{ start: new Date(now.getTime() - 3 * 86_400_000), end: overdueUnconfirmedEnd }] }],
    });

    const res = await req(enterpriseId).get("/sales-orders/promises").query({ limit: 200 });
    const item = res.body.items.find((i: { salesOrderId: string }) => i.salesOrderId === salesOrderId);
    expect(item.riskStatus).toBe("UNKNOWN"); // never silently SAFE just because the stale date happens to be before the promise
    expect(item.reasonCode).toBe("SCHEDULE_STALE");
    expect(item.explanation).toMatch(/stale/);
    expect(item.delayHours).toBeNull(); // never fabricate a delay number from unconfirmed data
  });

  it("Phase 15 — an IN_PROGRESS operation past its scheduled end is NOT treated as stale (a confirmed status is real evidence, even if running long)", async () => {
    const now = new Date();
    const promisedDate = new Date(now.getTime() + 10 * 86_400_000);
    const overdueButInProgressEnd = new Date(now.getTime() - 2 * 86_400_000);
    const { salesOrderId } = await makePromiseFixture({
      customerName: `InProgress Co ${suffix}`,
      orderNumber: `PI-INPROG-${suffix}`,
      promisedDate,
      lines: [
        {
          sourceType: "PRODUCTION",
          quantity: 2,
          scheduledOps: [{ start: new Date(now.getTime() - 3 * 86_400_000), end: overdueButInProgressEnd, status: "IN_PROGRESS" }],
        },
      ],
    });

    const res = await req(enterpriseId).get("/sales-orders/promises").query({ limit: 200 });
    const item = res.body.items.find((i: { salesOrderId: string }) => i.salesOrderId === salesOrderId);
    expect(item.reasonCode).not.toBe("SCHEDULE_STALE");
  });

  it("classifies an order as AT_RISK when an open production exception exists, even though not yet breached", async () => {
    const now = new Date();
    const promisedDate = new Date(now.getTime() + 10 * 86_400_000);
    const onTimeEnd = new Date(now.getTime() + 5 * 86_400_000);
    const { salesOrderId } = await makePromiseFixture({
      customerName: `AtRisk Co ${suffix}`,
      orderNumber: `PI-ATRISK-${suffix}`,
      promisedDate,
      lines: [{ sourceType: "PRODUCTION", quantity: 3, scheduledOps: [{ start: now, end: onTimeEnd }], openExceptions: 1 }],
    });

    const res = await req(enterpriseId).get("/sales-orders/promises").query({ limit: 200 });
    const item = res.body.items.find((i: { salesOrderId: string }) => i.salesOrderId === salesOrderId);
    expect(item.riskStatus).toBe("AT_RISK");
    expect(item.explanation).toMatch(/unresolved production exception/);
  });

  it("classifies an order as UNKNOWN when a PRODUCTION leg has no scheduled operations at all (missing evidence, never treated as zero delay)", async () => {
    const now = new Date();
    const promisedDate = new Date(now.getTime() + 10 * 86_400_000);
    const { salesOrderId } = await makePromiseFixture({
      customerName: `Unknown Co ${suffix}`,
      orderNumber: `PI-UNKNOWN-${suffix}`,
      promisedDate,
      lines: [{ sourceType: "PRODUCTION", quantity: 2 }], // no scheduledOps at all
    });

    const res = await req(enterpriseId).get("/sales-orders/promises").query({ limit: 200 });
    const item = res.body.items.find((i: { salesOrderId: string }) => i.salesOrderId === salesOrderId);
    expect(item.riskStatus).toBe("UNKNOWN");
    expect(item.delayHours).toBeNull();
  });

  it("classifies a pure-STOCK order (no production leg) as SAFE", async () => {
    const promisedDate = new Date(Date.now() + 10 * 86_400_000);
    const { salesOrderId } = await makePromiseFixture({
      customerName: `StockSafe Co ${suffix}`,
      orderNumber: `PI-STOCKSAFE-${suffix}`,
      promisedDate,
      lines: [{ sourceType: "STOCK", quantity: 4 }],
    });

    const res = await req(enterpriseId).get("/sales-orders/promises").query({ limit: 200 });
    const item = res.body.items.find((i: { salesOrderId: string }) => i.salesOrderId === salesOrderId);
    expect(item.riskStatus).toBe("SAFE");
    expect(item.reasonCode).toBe("NO_PRODUCTION_LEG");
    expect(item.scheduleAsOf).toBeNull(); // no production leg means no schedule evidence to date at all
  });

  it("a HYBRID order (STOCK + PRODUCTION legs) collapses into ONE inbox row, reflecting the WORST line's risk", async () => {
    const now = new Date();
    const promisedDate = new Date(now.getTime() + 2 * 86_400_000);
    const lateEnd = new Date(now.getTime() + 6 * 86_400_000); // breached
    const { salesOrderId } = await makePromiseFixture({
      customerName: `Hybrid Co ${suffix}`,
      orderNumber: `PI-HYBRID-${suffix}`,
      promisedDate,
      lines: [
        { sourceType: "STOCK", quantity: 2 },
        { sourceType: "PRODUCTION", quantity: 3, scheduledOps: [{ start: now, end: lateEnd }] },
      ],
    });

    const res = await req(enterpriseId).get("/sales-orders/promises").query({ limit: 200 });
    const matches = res.body.items.filter((i: { salesOrderId: string }) => i.salesOrderId === salesOrderId);
    expect(matches).toHaveLength(1); // one row per SalesOrder, never one per FulfillmentLine
    expect(matches[0].riskStatus).toBe("BREACHED"); // worst line wins, not averaged or hidden
    expect(matches[0].lines).toHaveLength(2); // both legs still visible in per-line detail
  });

  it("a pending RESCHEDULE_PRODUCTION approval sets workflowStatus=AWAITING_APPROVAL while riskStatus still reflects real current evidence", async () => {
    const now = new Date();
    const promisedDate = new Date(now.getTime() + 2 * 86_400_000);
    const lateEnd = new Date(now.getTime() + 6 * 86_400_000);
    const { salesOrderId, productionOrderIds: poIds } = await makePromiseFixture({
      customerName: `Pending Co ${suffix}`,
      orderNumber: `PI-PENDING-${suffix}`,
      promisedDate,
      lines: [{ sourceType: "PRODUCTION", quantity: 3, scheduledOps: [{ start: now, end: lateEnd }] }],
    });
    const run = await prisma.agentPipelineRun.create({
      data: {
        status: "COMPLETED",
        approvalAction: "RESCHEDULE_PRODUCTION",
        approvalStatus: "PENDING",
        approvalPayload: { production_order_id: poIds[0] },
        enterpriseId,
      },
    });
    agentPipelineRunIds.push(run.id);

    const res = await req(enterpriseId).get("/sales-orders/promises").query({ limit: 200 });
    const item = res.body.items.find((i: { salesOrderId: string }) => i.salesOrderId === salesOrderId);
    expect(item.riskStatus).toBe("BREACHED"); // unchanged by the pending approval
    expect(item.workflowStatus).toBe("AWAITING_APPROVAL");
    expect(item.pendingApprovalRunId).toBe(run.id);
  });

  it("a CONSUMED run with a verified-successful goal_satisfaction sets workflowStatus=RECOVERY_VERIFIED_RESTORED", async () => {
    const promisedDate = new Date(Date.now() + 10 * 86_400_000);
    const onTimeEnd = new Date(Date.now() + 5 * 86_400_000);
    const { salesOrderId, productionOrderIds: poIds } = await makePromiseFixture({
      customerName: `Restored Co ${suffix}`,
      orderNumber: `PI-RESTORED-${suffix}`,
      promisedDate,
      lines: [{ sourceType: "PRODUCTION", quantity: 3, scheduledOps: [{ start: new Date(), end: onTimeEnd }] }],
    });
    const run = await prisma.agentPipelineRun.create({
      data: {
        status: "COMPLETED",
        approvalAction: "RESCHEDULE_PRODUCTION",
        approvalStatus: "CONSUMED",
        approvalPayload: { production_order_id: poIds[0] },
        executionResult: { goal_satisfaction: { satisfied: true } },
        executedAt: new Date(),
        enterpriseId,
      },
    });
    agentPipelineRunIds.push(run.id);

    const res = await req(enterpriseId).get("/sales-orders/promises").query({ limit: 200 });
    const item = res.body.items.find((i: { salesOrderId: string }) => i.salesOrderId === salesOrderId);
    expect(item.workflowStatus).toBe("RECOVERY_VERIFIED_RESTORED");
    expect(item.riskStatus).toBe("SAFE");
  });

  it("never returns another enterprise's promises (tenant isolation)", async () => {
    const otherEnterprise = await prisma.enterprise.create({ data: { name: `other-pi-${suffix}`, timezone: "UTC", currency: "USD" } });
    try {
      const res = await req(otherEnterprise.id).get("/sales-orders/promises").query({ limit: 200 });
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
      expect(res.body.summary).toEqual({
        breached: 0,
        atRisk: 0,
        unknown: 0,
        safe: 0,
        awaitingApproval: 0,
        restoredAfterRecovery: 0,
        recoveryFailed: 0,
      });
    } finally {
      await prisma.enterprise.deleteMany({ where: { id: otherEnterprise.id } });
    }
  });

  it("filters by riskStatus and by search, without changing the summary counts", async () => {
    const resAll = await req(enterpriseId).get("/sales-orders/promises").query({ limit: 200 });
    const fullSummary = resAll.body.summary;

    const resFiltered = await req(enterpriseId).get("/sales-orders/promises").query({ limit: 200, riskStatus: "BREACHED" });
    expect(resFiltered.status).toBe(200);
    expect(resFiltered.body.items.every((i: { riskStatus: string }) => i.riskStatus === "BREACHED")).toBe(true);
    expect(resFiltered.body.summary).toEqual(fullSummary); // filtering the table must never move the summary cards

    const resSearch = await req(enterpriseId).get("/sales-orders/promises").query({ limit: 200, search: `Hybrid Co ${suffix}` });
    expect(resSearch.body.items.length).toBeGreaterThanOrEqual(1);
    expect(resSearch.body.items.every((i: { customerName: string }) => i.customerName.includes("Hybrid Co"))).toBe(true);
  });

  it("filters to only pending-approval items with pendingApprovalOnly=true", async () => {
    const res = await req(enterpriseId).get("/sales-orders/promises").query({ limit: 200, pendingApprovalOnly: "true" });
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThanOrEqual(1);
    expect(res.body.items.every((i: { workflowStatus: string }) => i.workflowStatus === "AWAITING_APPROVAL")).toBe(true);
  });

  it("paginates deterministically — limit/offset slice the same underlying sorted set", async () => {
    const page1 = await req(enterpriseId).get("/sales-orders/promises").query({ limit: 2, offset: 0 });
    const page2 = await req(enterpriseId).get("/sales-orders/promises").query({ limit: 2, offset: 2 });
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.total).toBe(page2.body.total);
    const page1Ids = page1.body.items.map((i: { salesOrderId: string }) => i.salesOrderId);
    const page2Ids = page2.body.items.map((i: { salesOrderId: string }) => i.salesOrderId);
    expect(page1Ids.some((id: string) => page2Ids.includes(id))).toBe(false); // no overlap
  });

  it("sorts BREACHED before AT_RISK before UNKNOWN before SAFE (deterministic prioritization)", async () => {
    const res = await req(enterpriseId).get("/sales-orders/promises").query({ limit: 200 });
    const order: Record<string, number> = { BREACHED: 0, AT_RISK: 1, UNKNOWN: 2, SAFE: 3 };
    const ranks = res.body.items.map((i: { riskStatus: string }) => order[i.riskStatus]);
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i - 1]);
    }
  });

  it("a read of the inbox never creates or mutates any FulfillmentLine, ProductionOrder, or AgentPipelineRun row", async () => {
    const [linesBefore, posBefore, runsBefore] = await Promise.all([
      prisma.fulfillmentLine.count({ where: { fulfillmentPlan: { orderLine: { orderId: { in: salesOrderIds } } } } }),
      prisma.productionOrder.count({ where: { id: { in: productionOrderIds } } }),
      prisma.agentPipelineRun.count({ where: { id: { in: agentPipelineRunIds } } }),
    ]);

    await req(enterpriseId).get("/sales-orders/promises").query({ limit: 200 });
    await req(enterpriseId).get("/sales-orders/promises").query({ limit: 200, search: "anything" });
    await req(enterpriseId).get("/sales-orders/promises").query({ limit: 200, riskStatus: "BREACHED,AT_RISK" });

    const [linesAfter, posAfter, runsAfter] = await Promise.all([
      prisma.fulfillmentLine.count({ where: { fulfillmentPlan: { orderLine: { orderId: { in: salesOrderIds } } } } }),
      prisma.productionOrder.count({ where: { id: { in: productionOrderIds } } }),
      prisma.agentPipelineRun.count({ where: { id: { in: agentPipelineRunIds } } }),
    ]);

    expect(linesAfter).toBe(linesBefore);
    expect(posAfter).toBe(posBefore);
    expect(runsAfter).toBe(runsBefore);
  });
});

// Scrap-aware completion work (P0 defect fix): PATCH /fulfillment-lines/:id
// gains fulfilledQuantity/shortfallReason. Deliberately self-contained
// fixture — not chained onto the describe block above — so these tests
// don't depend on, or affect, that block's own stateful test ordering.
describe("order-service — PATCH /fulfillment-lines/:id fulfilledQuantity/shortfallReason", () => {
  const suffix = randomUUID().slice(0, 8);
  let enterpriseId: string;
  let customerId: string;
  let salesOrderId: string;
  let lineId: string;
  const AUTH = { "x-internal-token": process.env.INTERNAL_SERVICE_TOKEN ?? "" };

  function identity(entId: string) {
    const token = shared.signIdentityAssertion(
      { sub: "test-user", type: "user", role: "PLANNER", enterpriseId: entId, aud: "aps-internal" },
      process.env.INTERNAL_SERVICE_TOKEN ?? ""
    );
    return { "x-identity-assertion": token };
  }

  beforeAll(async () => {
    const enterprise = await prisma.enterprise.create({ data: { name: `test-fq-${suffix}`, timezone: "UTC", currency: "USD" } });
    enterpriseId = enterprise.id;
    const customer = await prisma.customer.create({ data: { name: `Test Customer FQ ${suffix}`, enterpriseId } });
    customerId = customer.id;
    const salesOrder = await prisma.salesOrder.create({ data: { customerId, dueDate: new Date(), value: 1000, enterpriseId } });
    salesOrderId = salesOrder.id;
    const orderLine = await prisma.orderLine.create({
      data: { orderId: salesOrder.id, productName: "Test Widget", quantity: 100, unitPrice: 10 },
    });
    const plan = await prisma.fulfillmentPlan.create({ data: { orderLineId: orderLine.id, strategy: "MTO" } });
    const line = await prisma.fulfillmentLine.create({
      data: { fulfillmentPlanId: plan.id, sourceType: "PRODUCTION", quantity: 100, status: "IN_PROGRESS" },
    });
    lineId = line.id;
  });

  afterAll(async () => {
    await prisma.fulfillmentLine.deleteMany({ where: { id: lineId } });
    await prisma.fulfillmentPlan.deleteMany({ where: { orderLine: { orderId: salesOrderId } } });
    await prisma.orderLine.deleteMany({ where: { orderId: salesOrderId } });
    await prisma.salesOrder.deleteMany({ where: { id: salesOrderId } });
    await prisma.customer.deleteMany({ where: { id: customerId } });
    await prisma.enterprise.deleteMany({ where: { id: enterpriseId } });
  });

  it("sets fulfilledQuantity and shortfallReason without touching quantity or status — original demand is preserved", async () => {
    const res = await request(app)
      .patch(`/fulfillment-lines/${lineId}`)
      .set(AUTH)
      .set(identity(enterpriseId))
      .send({ fulfilledQuantity: 60, shortfallReason: "60 of 100 ordered units produced (40 short)" });

    expect(res.status).toBe(200);
    expect(res.body.fulfilledQuantity).toBe(60);
    expect(res.body.shortfallReason).toBe("60 of 100 ordered units produced (40 short)");
    expect(res.body.quantity).toBe(100); // untouched — the original demand, never overwritten
    expect(res.body.status).toBe("IN_PROGRESS"); // untouched — this write never transitions status
  });

  it("omitting shortfallReason (full completion, nothing short) leaves it null", async () => {
    const full = await prisma.fulfillmentLine.create({
      data: { fulfillmentPlanId: (await prisma.fulfillmentLine.findUniqueOrThrow({ where: { id: lineId } })).fulfillmentPlanId, sourceType: "PRODUCTION", quantity: 50, status: "IN_PROGRESS" },
    });
    try {
      const res = await request(app)
        .patch(`/fulfillment-lines/${full.id}`)
        .set(AUTH)
        .set(identity(enterpriseId))
        .send({ fulfilledQuantity: 50 });
      expect(res.status).toBe(200);
      expect(res.body.fulfilledQuantity).toBe(50);
      expect(res.body.shortfallReason).toBeNull();
    } finally {
      await prisma.fulfillmentLine.deleteMany({ where: { id: full.id } });
    }
  });

  it("retrying the same fulfilledQuantity write is a safe no-op (plain field overwrite, not an accumulator)", async () => {
    const first = await request(app).patch(`/fulfillment-lines/${lineId}`).set(AUTH).set(identity(enterpriseId)).send({ fulfilledQuantity: 75 });
    const retry = await request(app).patch(`/fulfillment-lines/${lineId}`).set(AUTH).set(identity(enterpriseId)).send({ fulfilledQuantity: 75 });
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200); // not a 409 — unlike a status-transition retry, this field has no race-detection guard needed
    expect(retry.body.fulfilledQuantity).toBe(75); // not 150 — confirms it's an overwrite, never an accumulator
  });

  it("a different enterprise's identity cannot patch this line (tenant isolation unaffected by the new fields)", async () => {
    const other = await prisma.enterprise.create({ data: { name: `test-fq-other-${suffix}`, timezone: "UTC", currency: "USD" } });
    try {
      const res = await request(app)
        .patch(`/fulfillment-lines/${lineId}`)
        .set(AUTH)
        .set(identity(other.id))
        .send({ fulfilledQuantity: 999 });
      expect(res.status).toBe(404); // same "not found" convention as every other cross-tenant access in this file
    } finally {
      await prisma.enterprise.deleteMany({ where: { id: other.id } });
    }
  });
});
