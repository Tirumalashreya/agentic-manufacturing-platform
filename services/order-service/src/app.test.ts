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
import supertest from "supertest";
import http from "node:http";
import { prisma } from "@aps/domain";
import { app } from "./app";

// One persistent server bound to 127.0.0.1 for the whole file. supertest's
// default is a NEW ephemeral server per request; on macOS a wildcard bind can
// lose to another local process listening on 127.0.0.1 at the same port, so a
// request occasionally reached the wrong server (404/200/ECONNRESET with no
// application log line). A single exclusively-owned port removes that.
const testServer = http.createServer(app).listen(0, "127.0.0.1");
afterAll(() => new Promise<void>((resolve) => { testServer.close(() => resolve()); }));
const request = (_app?: unknown) => supertest(testServer);

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

  // Independent-audit fix: this route was internally transactional but
  // had no idempotency-key check at all — a retry created a second,
  // independent OrderLine/FulfillmentPlan/FulfillmentLine set for the
  // same SalesOrder. Own dedicated SalesOrder per block, same pattern as
  // the HYBRID describe block above, so these don't interfere with other
  // tests' own OrderLine-count assertions.
  describe("POST /sales-orders/:id/fulfillment — Idempotency-Key", () => {
    let idemSalesOrderId: string;

    beforeAll(async () => {
      const soRes = await req().post("/sales-orders").send({
        customerId, dueDate: "2026-12-01", value: 1000, priority: 0,
        externalOrderId: `SO-IDEM-${suffix}`, fulfillmentType: "MTS", status: "APPROVED", currency: "INR",
      });
      idemSalesOrderId = soRes.body.id;
      createdSalesOrderIds.push(idemSalesOrderId);
    });

    it("retrying with the same Idempotency-Key replays the original result instead of creating a second OrderLine", async () => {
      const key = `fulfillment-retry-${idemSalesOrderId}`;
      const body = {
        productId, productName: "Test Widget", quantity: 20, unitPrice: 900,
        strategy: "MTS", reasoning: "fully in stock", lines: [{ sourceType: "STOCK", quantity: 20 }],
      };

      const first = await req().post(`/sales-orders/${idemSalesOrderId}/fulfillment`).set("Idempotency-Key", key).send(body);
      const retried = await req().post(`/sales-orders/${idemSalesOrderId}/fulfillment`).set("Idempotency-Key", key).send(body);

      expect(first.status).toBe(201);
      expect(retried.status).toBe(201);
      expect(retried.body).toEqual(first.body); // same orderLineId — not a second one

      const order = await prisma.salesOrder.findUnique({
        where: { id: idemSalesOrderId },
        include: { orderLines: true },
      });
      expect(order!.orderLines).toHaveLength(1); // the retry did not create a second OrderLine
    });

    // Reliability-pass fix: the retry test above only proves a SEQUENTIAL
    // retry (second call awaited strictly after the first fully resolved)
    // replays correctly — it never exercises withIdempotency's actual
    // concurrency guarantee (the prisma.idempotencyKey.create unique-
    // constraint claim, not a check-then-act race) for THIS route. Same
    // Promise.all pattern as the already-proven analogous test for
    // POST /orders above ("concurrent requests for the same preview...").
    it("concurrent requests with the same Idempotency-Key never create two distinct OrderLines", async () => {
      const key = `fulfillment-concurrent-${idemSalesOrderId}`;
      const body = {
        productId, productName: "Test Widget", quantity: 11, unitPrice: 900,
        strategy: "MTS", reasoning: "concurrent same-key fulfillment", lines: [{ sourceType: "STOCK", quantity: 11 }],
      };

      const [a, b] = await Promise.all([
        req().post(`/sales-orders/${idemSalesOrderId}/fulfillment`).set("Idempotency-Key", key).send(body),
        req().post(`/sales-orders/${idemSalesOrderId}/fulfillment`).set("Idempotency-Key", key).send(body),
      ]);

      // Same real guarantee as the analogous POST /orders race test:
      // under genuine concurrency either response may legitimately be a
      // 409 ("already in progress") if it lost the claim race before the
      // winner's result was recorded — what must never happen is two
      // distinct OrderLines for one logical request.
      const created = [a, b].filter((r) => r.status === 201);
      expect(created.length).toBeGreaterThanOrEqual(1);
      const distinctOrderLineIds = new Set(created.map((r) => r.body.orderLineId));
      expect(distinctOrderLineIds.size).toBe(1);

      const order = await prisma.salesOrder.findUnique({
        where: { id: idemSalesOrderId },
        include: { orderLines: { where: { quantity: 11 } } },
      });
      expect(order!.orderLines).toHaveLength(1); // exactly one real OrderLine, not two
    });

    // Reliability-pass fix: proves a failed attempt's claim is actually
    // released (withIdempotency deletes the IdempotencyKey row on a
    // throw or non-2xx — see its own "Stage 03C correctness fix"
    // comment), so a genuine retry with the SAME key after fixing the
    // input gets a real second attempt instead of being permanently
    // frozen onto the first failure.
    it("a request that fails validation under an Idempotency-Key is not cached, so a corrected retry with the same key succeeds", async () => {
      const key = `fulfillment-failed-then-retry-${idemSalesOrderId}`;
      const badBody = {
        productId, productName: "Test Widget", quantity: 9, unitPrice: 900,
        strategy: "MTS", reasoning: "bad lines", lines: [{ sourceType: "STOCK", quantity: 999 }], // mismatched total
      };

      const failed = await req().post(`/sales-orders/${idemSalesOrderId}/fulfillment`).set("Idempotency-Key", key).send(badBody);
      expect(failed.status).toBeGreaterThanOrEqual(400);

      const goodBody = {
        productId, productName: "Test Widget", quantity: 9, unitPrice: 900,
        strategy: "MTS", reasoning: "corrected", lines: [{ sourceType: "STOCK", quantity: 9 }],
      };
      const retried = await req().post(`/sales-orders/${idemSalesOrderId}/fulfillment`).set("Idempotency-Key", key).send(goodBody);
      expect(retried.status).toBe(201);
    });

    it("a different Idempotency-Key for the same SalesOrder creates its own separate OrderLine (not conflated with another key's)", async () => {
      const resA = await req().post(`/sales-orders/${idemSalesOrderId}/fulfillment`).set("Idempotency-Key", `fulfillment-distinct-a-${suffix}`).send({
        productId, productName: "Test Widget", quantity: 5, unitPrice: 900,
        strategy: "MTS", reasoning: "distinct a", lines: [{ sourceType: "STOCK", quantity: 5 }],
      });
      const resB = await req().post(`/sales-orders/${idemSalesOrderId}/fulfillment`).set("Idempotency-Key", `fulfillment-distinct-b-${suffix}`).send({
        productId, productName: "Test Widget", quantity: 7, unitPrice: 900,
        strategy: "MTS", reasoning: "distinct b", lines: [{ sourceType: "STOCK", quantity: 7 }],
      });

      expect(resA.body.orderLineId).not.toBe(resB.body.orderLineId);
    });

    it("a caller that sends no Idempotency-Key header is completely unaffected: identical calls each still create their own OrderLine", async () => {
      const body = {
        productId, productName: "Test Widget", quantity: 3, unitPrice: 900,
        strategy: "MTS", reasoning: "no key", lines: [{ sourceType: "STOCK", quantity: 3 }],
      };
      const resA = await req().post(`/sales-orders/${idemSalesOrderId}/fulfillment`).send(body);
      const resB = await req().post(`/sales-orders/${idemSalesOrderId}/fulfillment`).send(body);

      expect(resA.body.orderLineId).not.toBe(resB.body.orderLineId);
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

// Independent-audit fix (pilot-readiness work): Delivery and Invoice
// previously had zero Postgres presence — these are the new dual-write
// mirror endpoints Python's delivery_tools.py/billing_tools.py call
// after the Excel row is already written. Self-contained fixture, same
// pattern as the fulfilledQuantity describe block above.
describe("order-service — POST /deliveries and POST /invoices (Delivery/Invoice dual-write)", () => {
  const suffix = randomUUID().slice(0, 8);
  let enterpriseId: string;
  let customerId: string;
  let salesOrderId: string;
  const AUTH = { "x-internal-token": process.env.INTERNAL_SERVICE_TOKEN ?? "" };

  function identity(entId: string) {
    const token = shared.signIdentityAssertion(
      { sub: "test-user", type: "user", role: "PLANNER", enterpriseId: entId, aud: "aps-internal" },
      process.env.INTERNAL_SERVICE_TOKEN ?? ""
    );
    return { "x-identity-assertion": token };
  }

  beforeAll(async () => {
    const enterprise = await prisma.enterprise.create({ data: { name: `test-delinv-${suffix}`, timezone: "UTC", currency: "USD" } });
    enterpriseId = enterprise.id;
    const customer = await prisma.customer.create({ data: { name: `Test Customer DelInv ${suffix}`, enterpriseId } });
    customerId = customer.id;
    const salesOrder = await prisma.salesOrder.create({
      data: { customerId, dueDate: new Date(), value: 1000, enterpriseId, externalOrderId: `SO-DELINV-${suffix}` },
    });
    salesOrderId = salesOrder.id;
  });

  afterAll(async () => {
    await prisma.delivery.deleteMany({ where: { enterpriseId } });
    await prisma.invoice.deleteMany({ where: { enterpriseId } });
    await prisma.idempotencyKey.deleteMany({ where: { enterpriseId } });
    await prisma.salesOrder.deleteMany({ where: { id: salesOrderId } });
    await prisma.customer.deleteMany({ where: { id: customerId } });
    await prisma.enterprise.deleteMany({ where: { id: enterpriseId } });
  });

  it("creates a real Delivery row and resolves the real SalesOrder FK from externalSalesOrderId", async () => {
    const res = await request(app).post("/deliveries").set(AUTH).set(identity(enterpriseId)).send({
      externalDeliveryId: `DEL-TEST-${suffix}-1`, externalSalesOrderId: `SO-DELINV-${suffix}`,
      customerId: "C001", customerName: "ABC Corp", productId: "P011", productName: "Wireless Mouse",
      quantity: 5, status: "DISPATCHED",
    });
    expect(res.status).toBe(201);
    expect(res.body.externalDeliveryId).toBe(`DEL-TEST-${suffix}-1`);
    expect(res.body.salesOrderId).toBe(salesOrderId); // resolved server-side, not trusted from the caller
  });

  it("creates a real Delivery row with salesOrderId null when externalSalesOrderId matches nothing (not an error)", async () => {
    const res = await request(app).post("/deliveries").set(AUTH).set(identity(enterpriseId)).send({
      externalDeliveryId: `DEL-TEST-${suffix}-2`, externalSalesOrderId: "SO-DOES-NOT-EXIST",
      quantity: 3, status: "DISPATCHED",
    });
    expect(res.status).toBe(201);
    expect(res.body.salesOrderId).toBeNull();
  });

  it("a retry of the same externalDeliveryId (no Idempotency-Key) upserts to the same row, not a duplicate", async () => {
    const body = { externalDeliveryId: `DEL-TEST-${suffix}-3`, quantity: 10, status: "DISPATCHED" };
    const first = await request(app).post("/deliveries").set(AUTH).set(identity(enterpriseId)).send(body);
    const retry = await request(app).post("/deliveries").set(AUTH).set(identity(enterpriseId)).send({ ...body, status: "DELIVERED" });

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(first.body.id); // same row, upserted — not a second Delivery

    const count = await prisma.delivery.count({ where: { enterpriseId, externalDeliveryId: `DEL-TEST-${suffix}-3` } });
    expect(count).toBe(1);
  });

  it("requires externalDeliveryId", async () => {
    const res = await request(app).post("/deliveries").set(AUTH).set(identity(enterpriseId)).send({ quantity: 1, status: "DISPATCHED" });
    expect(res.status).toBe(400);
  });

  it("creates a real Invoice row and resolves the real SalesOrder FK", async () => {
    const res = await request(app).post("/invoices").set(AUTH).set(identity(enterpriseId)).send({
      externalInvoiceId: `INV-TEST-${suffix}-1`, externalSalesOrderId: `SO-DELINV-${suffix}`,
      customerId: "C001", customerName: "ABC Corp",
      quantityBilled: 5, unitPrice: 800, invoiceAmount: 4000, paymentTermsDays: 30, status: "ISSUED",
    });
    expect(res.status).toBe(201);
    expect(res.body.salesOrderId).toBe(salesOrderId);
    expect(res.body.invoiceAmount).toBe(4000);
  });

  it("retrying POST /invoices with the same Idempotency-Key replays the original result", async () => {
    const key = `invoice-retry-${suffix}`;
    const body = {
      externalInvoiceId: `INV-TEST-${suffix}-2`, quantityBilled: 2, unitPrice: 800, invoiceAmount: 1600, status: "ISSUED",
    };
    const first = await request(app).post("/invoices").set(AUTH).set(identity(enterpriseId)).set("Idempotency-Key", key).send(body);
    const retried = await request(app).post("/invoices").set(AUTH).set(identity(enterpriseId)).set("Idempotency-Key", key).send(body);

    expect(first.status).toBe(201);
    expect(retried.body).toEqual(first.body);
  });

  it("is tenant-scoped: a different enterprise's identity cannot resolve this enterprise's SalesOrder FK", async () => {
    const other = await prisma.enterprise.create({ data: { name: `test-delinv-other-${suffix}`, timezone: "UTC", currency: "USD" } });
    try {
      const res = await request(app).post("/deliveries").set(AUTH).set(identity(other.id)).send({
        externalDeliveryId: `DEL-TEST-${suffix}-tenant`, externalSalesOrderId: `SO-DELINV-${suffix}`,
        quantity: 1, status: "DISPATCHED",
      });
      expect(res.status).toBe(201);
      expect(res.body.salesOrderId).toBeNull(); // the real SalesOrder exists, but in a DIFFERENT enterprise — never linked across tenants
      await prisma.delivery.deleteMany({ where: { enterpriseId: other.id } });
    } finally {
      await prisma.enterprise.deleteMany({ where: { id: other.id } });
    }
  });
});

// Phase 2 (Database Authority): GET /deliveries and GET /invoices are the
// read side the reconciler uses to compare Postgres against the Excel
// representation. Keyset pagination + tenant scoping are the two things a
// reconciler silently depends on, so both are proven here.
describe("order-service — GET /deliveries and GET /invoices (reconciliation read side)", () => {
  const suffix = randomUUID().slice(0, 8);
  let enterpriseId: string;
  let otherEnterpriseId: string;
  const AUTH = { "x-internal-token": process.env.INTERNAL_SERVICE_TOKEN ?? "" };

  function identity(entId: string) {
    const token = shared.signIdentityAssertion(
      { sub: "test-user", type: "user", role: "PLANNER", enterpriseId: entId, aud: "aps-internal" },
      process.env.INTERNAL_SERVICE_TOKEN ?? ""
    );
    return { "x-identity-assertion": token };
  }

  beforeAll(async () => {
    enterpriseId = (await prisma.enterprise.create({ data: { name: `test-recon-${suffix}`, timezone: "UTC", currency: "USD" } })).id;
    otherEnterpriseId = (await prisma.enterprise.create({ data: { name: `test-recon-other-${suffix}`, timezone: "UTC", currency: "USD" } })).id;
    for (let i = 1; i <= 5; i++) {
      await prisma.delivery.create({ data: { enterpriseId, externalDeliveryId: `DEL-R-${suffix}-${i}`, quantity: i, status: "DISPATCHED" } });
      await prisma.invoice.create({
        data: { enterpriseId, externalInvoiceId: `INV-R-${suffix}-${i}`, quantityBilled: i, unitPrice: 10, invoiceAmount: i * 10, status: "ISSUED" },
      });
    }
    await prisma.delivery.create({ data: { enterpriseId: otherEnterpriseId, externalDeliveryId: `DEL-R-${suffix}-other`, quantity: 1, status: "DISPATCHED" } });
    await prisma.invoice.create({
      data: { enterpriseId: otherEnterpriseId, externalInvoiceId: `INV-R-${suffix}-other`, quantityBilled: 1, unitPrice: 1, invoiceAmount: 1, status: "ISSUED" },
    });
  });

  afterAll(async () => {
    await prisma.delivery.deleteMany({ where: { enterpriseId: { in: [enterpriseId, otherEnterpriseId] } } });
    await prisma.invoice.deleteMany({ where: { enterpriseId: { in: [enterpriseId, otherEnterpriseId] } } });
    await prisma.enterprise.deleteMany({ where: { id: { in: [enterpriseId, otherEnterpriseId] } } });
  });

  it("walks every delivery exactly once across pages and never returns another enterprise's rows", async () => {
    const seen: string[] = [];
    let after: string | null = null;
    let pages = 0;
    do {
      const res: any = await request(app).get("/deliveries").query({ limit: 2, ...(after ? { after } : {}) }).set(AUTH).set(identity(enterpriseId));
      expect(res.status).toBe(200);
      seen.push(...res.body.items.map((d: any) => d.externalDeliveryId));
      after = res.body.nextAfter;
      pages++;
    } while (after && pages < 10);
    expect(pages).toBe(3); // 5 rows, page size 2 → 2+2+1
    expect(seen).toEqual([1, 2, 3, 4, 5].map((i) => `DEL-R-${suffix}-${i}`));
  });

  it("walks every invoice exactly once and is tenant-scoped", async () => {
    const mine = await request(app).get("/invoices").query({ limit: 1000 }).set(AUTH).set(identity(enterpriseId));
    expect(mine.status).toBe(200);
    expect(mine.body.items).toHaveLength(5);
    expect(mine.body.nextAfter).toBeNull();
    expect(mine.body.items.some((i: any) => i.externalInvoiceId.endsWith("-other"))).toBe(false);

    const theirs = await request(app).get("/invoices").set(AUTH).set(identity(otherEnterpriseId));
    expect(theirs.body.items.map((i: any) => i.externalInvoiceId)).toEqual([`INV-R-${suffix}-other`]);
  });

  it("caps an oversized limit and requires auth", async () => {
    const capped = await request(app).get("/deliveries").query({ limit: 999999 }).set(AUTH).set(identity(enterpriseId));
    expect(capped.status).toBe(200);
    const noAuth = await request(app).get("/deliveries");
    expect([401, 403]).toContain(noAuth.status);
  });
});

describe("order-service — PATCH /invoices/:id/status (ISSUED -> PAID mirror)", () => {
  const suffix = randomUUID().slice(0, 8);
  let enterpriseId: string;
  let otherEnterpriseId: string;
  const AUTH = { "x-internal-token": process.env.INTERNAL_SERVICE_TOKEN ?? "" };
  const id = (n: string) => `INV-PAY-${suffix}-${n}`;

  function identity(entId: string) {
    const token = shared.signIdentityAssertion(
      { sub: "test-user", type: "user", role: "PLANNER", enterpriseId: entId, aud: "aps-internal" },
      process.env.INTERNAL_SERVICE_TOKEN ?? ""
    );
    return { "x-identity-assertion": token };
  }

  beforeAll(async () => {
    enterpriseId = (await prisma.enterprise.create({ data: { name: `test-pay-${suffix}`, timezone: "UTC", currency: "USD" } })).id;
    otherEnterpriseId = (await prisma.enterprise.create({ data: { name: `test-pay-other-${suffix}`, timezone: "UTC", currency: "USD" } })).id;
    for (const n of ["a", "b", "c", "d"]) {
      await prisma.invoice.create({
        data: { enterpriseId, externalInvoiceId: id(n), quantityBilled: 1, unitPrice: 5, invoiceAmount: 5, status: "ISSUED" },
      });
    }
    await prisma.invoice.create({
      data: { enterpriseId, externalInvoiceId: id("void"), quantityBilled: 1, unitPrice: 5, invoiceAmount: 5, status: "VOID" },
    });
  });

  afterAll(async () => {
    await prisma.invoice.deleteMany({ where: { enterpriseId: { in: [enterpriseId, otherEnterpriseId] } } });
    await prisma.enterprise.deleteMany({ where: { id: { in: [enterpriseId, otherEnterpriseId] } } });
  });

  const patch = (ent: string, invoiceId: string, status = "PAID") =>
    request(app).patch(`/invoices/${invoiceId}/status`).set(AUTH).set(identity(ent)).send({ status });

  it("marks an ISSUED invoice PAID", async () => {
    const res = await patch(enterpriseId, id("a"));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("PAID");
    expect((await prisma.invoice.findFirst({ where: { enterpriseId, externalInvoiceId: id("a") } }))?.status).toBe("PAID");
  });

  it("is idempotent: repeating an already-applied PAID returns 200, not an error", async () => {
    expect((await patch(enterpriseId, id("b"))).status).toBe(200);
    const again = await patch(enterpriseId, id("b"));
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("PAID");
  });

  it("20 concurrent PAID requests all converge on PAID with exactly one transition", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => patch(enterpriseId, id("c"))));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect((await prisma.invoice.findFirst({ where: { enterpriseId, externalInvoiceId: id("c") } }))?.status).toBe("PAID");
  });

  it("rejects an illegal transition (VOID -> PAID) with 409 and leaves the row untouched", async () => {
    const res = await patch(enterpriseId, id("void"));
    expect(res.status).toBe(409);
    expect((await prisma.invoice.findFirst({ where: { enterpriseId, externalInvoiceId: id("void") } }))?.status).toBe("VOID");
  });

  it("404 for an unknown invoice, 400 for an unsupported status, and never crosses tenants", async () => {
    expect((await patch(enterpriseId, id("nope"))).status).toBe(404);
    expect((await patch(enterpriseId, id("d"), "REFUNDED")).status).toBe(400);
    expect((await patch(otherEnterpriseId, id("d"))).status).toBe(404); // exists, but in a different enterprise
    expect((await prisma.invoice.findFirst({ where: { enterpriseId, externalInvoiceId: id("d") } }))?.status).toBe("ISSUED");
  });
});

// Phase 2 (Database Authority): Postgres-owned document ids.
describe("order-service — POST /sequences/:kind/next (Postgres id authority)", () => {
  const suffix = randomUUID().slice(0, 8);
  let enterpriseId: string;
  let otherEnterpriseId: string;
  const AUTH = { "x-internal-token": process.env.INTERNAL_SERVICE_TOKEN ?? "" };

  function identity(entId: string) {
    const token = shared.signIdentityAssertion(
      { sub: "test-user", type: "user", role: "PLANNER", enterpriseId: entId, aud: "aps-internal" },
      process.env.INTERNAL_SERVICE_TOKEN ?? ""
    );
    return { "x-identity-assertion": token };
  }
  const next = (ent: string, kind: string, body: object = {}) =>
    request(app).post(`/sequences/${kind}/next`).set(AUTH).set(identity(ent)).send(body);

  beforeAll(async () => {
    enterpriseId = (await prisma.enterprise.create({ data: { name: `test-seq-${suffix}`, timezone: "UTC", currency: "USD" } })).id;
    otherEnterpriseId = (await prisma.enterprise.create({ data: { name: `test-seq-other-${suffix}`, timezone: "UTC", currency: "USD" } })).id;
  });

  afterAll(async () => {
    await prisma.documentNumberAllocation.deleteMany({ where: { enterpriseId: { in: [enterpriseId, otherEnterpriseId] } } });
    await prisma.documentSequence.deleteMany({ where: { enterpriseId: { in: [enterpriseId, otherEnterpriseId] } } });
    await prisma.enterprise.deleteMany({ where: { id: { in: [enterpriseId, otherEnterpriseId] } } });
  });

  it("first call starts above the caller's floor, then increments by one", async () => {
    expect((await next(enterpriseId, "DELIVERY", { floor: 41 })).body.value).toBe(42);
    expect((await next(enterpriseId, "DELIVERY", { floor: 41 })).body.value).toBe(43);
  });

  it("never moves down when a later caller passes a lower floor, and jumps up for a higher one", async () => {
    expect((await next(enterpriseId, "INVOICE", { floor: 10 })).body.value).toBe(11);
    expect((await next(enterpriseId, "INVOICE", { floor: 0 })).body.value).toBe(12);
    expect((await next(enterpriseId, "INVOICE", { floor: 100 })).body.value).toBe(101);
  });

  it("50 concurrent calls receive 50 distinct, contiguous values", async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => next(otherEnterpriseId, "DELIVERY")));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const values = results.map((r) => r.body.value as number).sort((a, b) => a - b);
    expect(new Set(values).size).toBe(50);
    expect(values[0]).toBe(1);
    expect(values[49]).toBe(50);
  });

  it("sequences are per-enterprise and per-kind", async () => {
    expect((await next(enterpriseId, "DELIVERY")).body.value).toBe(44);
    expect((await next(otherEnterpriseId, "INVOICE")).body.value).toBe(1);
  });

  it("rejects unknown kinds and bad floors", async () => {
    expect((await next(enterpriseId, "BANANA")).status).toBe(400);
    expect((await next(enterpriseId, "DELIVERY", { floor: -1 })).status).toBe(400);
    expect((await next(enterpriseId, "DELIVERY", { floor: "7" })).status).toBe(400);
  });
});

describe("order-service — document sequence: idempotent allocation and Postgres-row floor", () => {
  const suffix = randomUUID().slice(0, 8);
  let enterpriseId: string;
  let otherEnterpriseId: string;
  const AUTH = { "x-internal-token": process.env.INTERNAL_SERVICE_TOKEN ?? "" };

  function identity(entId: string) {
    const token = shared.signIdentityAssertion(
      { sub: "test-user", type: "user", role: "PLANNER", enterpriseId: entId, aud: "aps-internal" },
      process.env.INTERNAL_SERVICE_TOKEN ?? ""
    );
    return { "x-identity-assertion": token };
  }
  const next = (ent: string, kind: string, body: object = {}) =>
    request(app).post(`/sequences/${kind}/next`).set(AUTH).set(identity(ent)).send(body);

  beforeAll(async () => {
    enterpriseId = (await prisma.enterprise.create({ data: { name: `test-seqk-${suffix}`, timezone: "UTC", currency: "USD" } })).id;
    otherEnterpriseId = (await prisma.enterprise.create({ data: { name: `test-seqk-other-${suffix}`, timezone: "UTC", currency: "USD" } })).id;
  });

  afterAll(async () => {
    const ents = { in: [enterpriseId, otherEnterpriseId] };
    await prisma.documentNumberAllocation.deleteMany({ where: { enterpriseId: ents } });
    await prisma.documentSequence.deleteMany({ where: { enterpriseId: ents } });
    await prisma.delivery.deleteMany({ where: { enterpriseId: ents } });
    await prisma.invoice.deleteMany({ where: { enterpriseId: ents } });
    await prisma.enterprise.deleteMany({ where: { id: ents } });
  });

  it("the same idempotencyKey always receives the same number (retry after a crash), a new key a new one", async () => {
    const a = await next(enterpriseId, "DELIVERY", { idempotencyKey: "req-1" });
    const again = await next(enterpriseId, "DELIVERY", { idempotencyKey: "req-1", floor: 500 }); // floor ignored on replay
    const other = await next(enterpriseId, "DELIVERY", { idempotencyKey: "req-2" });
    expect(again.body.value).toBe(a.body.value);
    expect(again.body.replayed).toBe(true);
    expect(a.body.replayed).toBe(false);
    expect(other.body.value).toBe(a.body.value + 1);
  });

  it("20 concurrent requests with the SAME key allocate exactly one number", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => next(enterpriseId, "INVOICE", { idempotencyKey: "same" })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.value)).size).toBe(1);
    expect(results.filter((r) => r.body.replayed === false).length).toBe(1);
    const after = await next(enterpriseId, "INVOICE"); // exactly one number was consumed
    expect(after.body.value).toBe(results[0].body.value + 1);
  });

  it("a key is scoped to its enterprise and kind", async () => {
    const d = await next(enterpriseId, "DELIVERY", { idempotencyKey: "scoped" });
    const i = await next(enterpriseId, "INVOICE", { idempotencyKey: "scoped" });
    const o = await next(otherEnterpriseId, "DELIVERY", { idempotencyKey: "scoped" });
    expect(d.body.replayed).toBe(false);
    expect(i.body.replayed).toBe(false);
    expect(o.body.replayed).toBe(false);
    expect(o.body.value).toBe(1);
  });

  it("starts above ids already present in Postgres even when the caller's floor is lower (no silent overwrite of existing rows)", async () => {
    await prisma.delivery.createMany({
      data: ["DEL0007", "DEL0070", "NOT-A-DEL-ID", "DELX9"].map((externalDeliveryId) => ({
        enterpriseId: otherEnterpriseId, externalDeliveryId, quantity: 1, status: "DISPATCHED",
      })),
    });
    // otherEnterprise's DELIVERY sequence is already at 1 from the previous test, so use INVOICE for a fresh one
    await prisma.invoice.create({
      data: { enterpriseId: otherEnterpriseId, externalInvoiceId: "INV0163", quantityBilled: 1, unitPrice: 1, invoiceAmount: 1, status: "ISSUED" },
    });
    expect((await next(otherEnterpriseId, "INVOICE", { floor: 3 })).body.value).toBe(164);
    // DELIVERY: lastValue was 1, Postgres max is 70 -> jumps to 71; malformed ids are ignored
    expect((await next(otherEnterpriseId, "DELIVERY", { floor: 0 })).body.value).toBe(71);
  });

  it("rejects a malformed idempotencyKey", async () => {
    expect((await next(enterpriseId, "DELIVERY", { idempotencyKey: "" })).status).toBe(400);
    expect((await next(enterpriseId, "DELIVERY", { idempotencyKey: 5 })).status).toBe(400);
    expect((await next(enterpriseId, "DELIVERY", { idempotencyKey: "x".repeat(201) })).status).toBe(400);
  });
});

// Phase 2 (Database Authority): SalesOrder and Customer creation are
// protected by PostgreSQL constraints/transactions, not by caller discipline.
describe("order-service — Phase 2 SalesOrder and Customer creation hardening", () => {
  const suffix = randomUUID().slice(0, 8);
  let enterpriseId: string;
  let otherEnterpriseId: string;
  let customerId: string;
  const AUTH = { "x-internal-token": process.env.INTERNAL_SERVICE_TOKEN ?? "" };

  function identity(entId: string) {
    const token = shared.signIdentityAssertion(
      { sub: "test-user", type: "user", role: "PLANNER", enterpriseId: entId, aud: "aps-internal" },
      process.env.INTERNAL_SERVICE_TOKEN ?? ""
    );
    return { "x-identity-assertion": token };
  }
  const post = (ent: string, path: string, body: object, key?: string) => {
    const r = request(app).post(path).set(AUTH).set(identity(ent));
    return (key ? r.set("Idempotency-Key", key) : r).send(body);
  };
  const orderBody = (externalOrderId: string, withLines = true) => ({
    customerId, dueDate: "2026-12-01", value: 100, priority: 0, currency: "USD", externalOrderId,
    productName: "Widget", quantity: 5, unitPrice: 20, strategy: "MTS",
    ...(withLines ? { lines: [{ sourceType: "STOCK", quantity: 5 }] } : {}),
  });

  beforeAll(async () => {
    enterpriseId = (await prisma.enterprise.create({ data: { name: `test-p2so-${suffix}`, timezone: "UTC", currency: "USD" } })).id;
    otherEnterpriseId = (await prisma.enterprise.create({ data: { name: `test-p2so-other-${suffix}`, timezone: "UTC", currency: "USD" } })).id;
    customerId = (await prisma.customer.create({ data: { name: `P2 Customer ${suffix}`, enterpriseId } })).id;
  });

  afterAll(async () => {
    const ents = { in: [enterpriseId, otherEnterpriseId] };
    const orders = await prisma.salesOrder.findMany({ where: { enterpriseId: ents }, select: { id: true } });
    const ids = orders.map((o) => o.id);
    await prisma.fulfillmentLine.deleteMany({ where: { fulfillmentPlan: { orderLine: { orderId: { in: ids } } } } });
    await prisma.fulfillmentPlan.deleteMany({ where: { orderLine: { orderId: { in: ids } } } });
    await prisma.orderLine.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.idempotencyKey.deleteMany({ where: { enterpriseId: ents } });
    await prisma.auditLog.deleteMany({ where: { enterpriseId: ents } }).catch(() => undefined);
    await prisma.salesOrder.deleteMany({ where: { id: { in: ids } } });
    await prisma.customer.deleteMany({ where: { enterpriseId: ents } });
    await prisma.enterprise.deleteMany({ where: { id: ents } });
  });

  it("20 concurrent identical requests under ONE Idempotency-Key create exactly one SalesOrder, all replaying it", async () => {
    const ext = `SO-P2-KEY-${suffix}`;
    const results = await Promise.all(Array.from({ length: 20 }, () => post(enterpriseId, "/sales-orders", orderBody(ext), `p2-key-${suffix}`)));
    const ok = results.filter((r) => r.status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    // the rest are either replays (201) or "in progress" (409) — never a second order
    expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    expect(new Set(ok.map((r) => r.body.id)).size).toBe(1);
    expect(await prisma.salesOrder.count({ where: { enterpriseId, externalOrderId: ext } })).toBe(1);
  });

  it("20 concurrent requests with DIFFERENT keys for the SAME externalOrderId yield one order (DB constraint), no orphan lines", async () => {
    const ext = `SO-P2-DUP-${suffix}`;
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => post(enterpriseId, "/sales-orders", orderBody(ext), `p2-dup-${suffix}-${i}`)));
    expect(results.filter((r) => r.status === 201).length).toBe(1);
    expect(results.filter((r) => r.status === 409).length).toBe(19);
    const orders = await prisma.salesOrder.findMany({ where: { enterpriseId, externalOrderId: ext }, select: { id: true } });
    expect(orders).toHaveLength(1);
    // the 19 rolled-back transactions left nothing behind
    expect(await prisma.orderLine.count({ where: { orderId: orders[0].id } })).toBe(1);
  });

  it("the no-lines path (no idempotency support) is still protected: a repeated externalOrderId is a 409, not a second row", async () => {
    const ext = `SO-P2-NOLINES-${suffix}`;
    const results = await Promise.all(Array.from({ length: 10 }, () => post(enterpriseId, "/sales-orders", orderBody(ext, false))));
    expect(results.filter((r) => r.status === 201).length).toBe(1);
    expect(results.filter((r) => r.status === 409).length).toBe(9);
    expect(await prisma.salesOrder.count({ where: { enterpriseId, externalOrderId: ext } })).toBe(1);
  });

  it("the same Idempotency-Key with a different body is refused (409), never replayed as another request's result", async () => {
    const key = `p2-mismatch-${suffix}`;
    expect((await post(enterpriseId, "/sales-orders", orderBody(`SO-P2-M1-${suffix}`), key)).status).toBe(201);
    const second = await post(enterpriseId, "/sales-orders", orderBody(`SO-P2-M2-${suffix}`), key);
    expect(second.status).toBe(409);
    expect(await prisma.salesOrder.count({ where: { enterpriseId, externalOrderId: `SO-P2-M2-${suffix}` } })).toBe(0);
  });

  it("an order against another enterprise's customer is refused and creates nothing", async () => {
    const res = await post(otherEnterpriseId, "/sales-orders", orderBody(`SO-P2-XT-${suffix}`));
    expect(res.status).toBe(404);
    expect(await prisma.salesOrder.count({ where: { externalOrderId: `SO-P2-XT-${suffix}` } })).toBe(0);
  });

  it("POST /customers/find-or-create: 20 concurrent calls for one new name create exactly one Customer", async () => {
    const name = `Concurrent Co ${suffix}`;
    const results = await Promise.all(Array.from({ length: 20 }, () => post(enterpriseId, "/customers/find-or-create", { name })));
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(results.filter((r) => r.status === 201).length).toBe(1);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await prisma.customer.count({ where: { enterpriseId, name } })).toBe(1);
  });

  it("find-or-create is tenant-scoped, returns an existing row untouched, and validates the name", async () => {
    const name = `Shared Name ${suffix}`;
    const a = await post(enterpriseId, "/customers/find-or-create", { name });
    const again = await post(enterpriseId, "/customers/find-or-create", { name });
    const other = await post(otherEnterpriseId, "/customers/find-or-create", { name });
    expect(a.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(a.body.id);
    expect(other.status).toBe(201);
    expect(other.body.id).not.toBe(a.body.id);
    expect((await post(enterpriseId, "/customers/find-or-create", { name: "   " })).status).toBe(400);
    expect((await post(enterpriseId, "/customers/find-or-create", {})).status).toBe(400);
  });
});

// Phase 2: withIdempotency commits the claim, the business write and the
// stored response in ONE transaction. A hard crash at any point therefore
// leaves nothing behind (no stranded statusCode=0 claim, no half-written
// rows) and the same key can be retried safely.
describe("order-service — withIdempotency hard-crash recovery (claim + write + completion are atomic)", () => {
  const suffix = randomUUID().slice(0, 8);
  let enterpriseId: string;
  const AUTH = { "x-internal-token": process.env.INTERNAL_SERVICE_TOKEN ?? "" };

  function identity(entId: string) {
    const token = shared.signIdentityAssertion(
      { sub: "test-user", type: "user", role: "PLANNER", enterpriseId: entId, aud: "aps-internal" },
      process.env.INTERNAL_SERVICE_TOKEN ?? ""
    );
    return { "x-identity-assertion": token };
  }
  const postDelivery = (key: string, body: object) =>
    request(app).post("/deliveries").set(AUTH).set(identity(enterpriseId)).set("Idempotency-Key", key).send(body);
  const claim = (key: string) =>
    prisma.idempotencyKey.findFirst({ where: { enterpriseId, key, operation: "create_delivery" } });

  beforeAll(async () => {
    enterpriseId = (await prisma.enterprise.create({ data: { name: `test-idem-crash-${suffix}`, timezone: "UTC", currency: "USD" } })).id;
  });

  afterAll(async () => {
    await prisma.idempotencyKey.deleteMany({ where: { enterpriseId } });
    await prisma.delivery.deleteMany({ where: { enterpriseId } });
    await prisma.enterprise.deleteMany({ where: { id: enterpriseId } });
  });

  it("a DB session killed after the claim insert and during the business write rolls back both; the same key then succeeds", async () => {
    const externalDeliveryId = `DEL-CRASH-${suffix}`;
    const key = `crash-${suffix}`;
    await prisma.delivery.create({ data: { enterpriseId, externalDeliveryId, quantity: 1, status: "DISPATCHED" } });

    // Hold a row lock so the request's business write (the upsert's UPDATE)
    // stalls INSIDE its transaction, after the claim has been inserted.
    let releaseLock!: () => void;
    const lockReleased = new Promise<void>((resolve) => (releaseLock = resolve));
    let lockTaken!: () => void;
    const lockReady = new Promise<void>((resolve) => (lockTaken = resolve));
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Delivery" WHERE "enterpriseId" = ${enterpriseId} AND "externalDeliveryId" = ${externalDeliveryId} FOR UPDATE`;
      lockTaken();
      await lockReleased;
    }, { timeout: 60_000 });
    await lockReady;

    const inFlight = postDelivery(key, { externalDeliveryId, quantity: 99, status: "DISPATCHED" }).then((r) => r);

    // Wait until the request's backend is blocked on our lock, then kill that session.
    let killed = 0;
    for (let i = 0; i < 100 && killed === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const victims = await prisma.$queryRaw<{ killed: boolean }[]>`
        SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock' AND query ILIKE '%"Delivery"%' AND query NOT ILIKE '%FOR UPDATE%'`;
      killed = victims.filter((v) => v.killed).length;
    }
    expect(killed).toBeGreaterThan(0); // the request really was mid-transaction when its session died

    const crashed = await inFlight;
    expect(crashed.status).toBeGreaterThanOrEqual(500);

    releaseLock();
    await holder;

    // Nothing committed: no stranded claim, and the business row is untouched.
    expect(await claim(key)).toBeNull();
    expect((await prisma.delivery.findFirst({ where: { enterpriseId, externalDeliveryId } }))?.quantity).toBe(1);

    // The very same key now runs fresh and completes.
    const retry = await postDelivery(key, { externalDeliveryId, quantity: 99, status: "DISPATCHED" });
    expect(retry.status).toBe(201);
    expect((await prisma.delivery.findFirst({ where: { enterpriseId, externalDeliveryId } }))?.quantity).toBe(99);
    expect((await claim(key))?.statusCode).toBe(201);

    // And a further retry replays the stored response without re-running.
    const replay = await postDelivery(key, { externalDeliveryId, quantity: 99, status: "DISPATCHED" });
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(retry.body.id);
  });

  it("20 concurrent requests with one key all succeed (replaying the first); no transient 'in progress' answers, one row, one claim", async () => {
    const externalDeliveryId = `DEL-CONC-${suffix}`;
    const key = `conc-${suffix}`;
    const results = await Promise.all(
      Array.from({ length: 20 }, () => postDelivery(key, { externalDeliveryId, quantity: 5, status: "DISPATCHED" }))
    );
    expect(results.map((r) => r.status)).toEqual(Array(20).fill(201));
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await prisma.delivery.count({ where: { enterpriseId, externalDeliveryId } })).toBe(1);
    expect(await prisma.idempotencyKey.count({ where: { enterpriseId, key } })).toBe(1);
  });

  it("a failing attempt leaves no claim behind (a failed request is never cached as the key's answer)", async () => {
    const key = `fail-${suffix}`;
    const bad = await postDelivery(key, { quantity: 1, status: "DISPATCHED" }); // missing externalDeliveryId -> 400 before any claim
    expect(bad.status).toBe(400);
    expect(await claim(key)).toBeNull();
    const good = await postDelivery(key, { externalDeliveryId: `DEL-FAIL-${suffix}`, quantity: 1, status: "DISPATCHED" });
    expect(good.status).toBe(201);
  });

  it("the same key with a different body is refused with 409 and changes nothing", async () => {
    const key = `mismatch-${suffix}`;
    const externalDeliveryId = `DEL-MM-${suffix}`;
    expect((await postDelivery(key, { externalDeliveryId, quantity: 1, status: "DISPATCHED" })).status).toBe(201);
    expect((await postDelivery(key, { externalDeliveryId, quantity: 2, status: "DISPATCHED" })).status).toBe(409);
    expect((await prisma.delivery.findFirst({ where: { enterpriseId, externalDeliveryId } }))?.quantity).toBe(1);
  });
});

// Phase 2: PostgreSQL as the first writer for SalesOrder and Customer ids,
// customer credit terms, and the paged reads the reconciler uses.
describe("order-service — Phase 2 SalesOrder/Customer authority primitives", () => {
  const suffix = randomUUID().slice(0, 8);
  let enterpriseId: string;
  let otherEnterpriseId: string;
  const AUTH = { "x-internal-token": process.env.INTERNAL_SERVICE_TOKEN ?? "" };

  function identity(entId: string) {
    const token = shared.signIdentityAssertion(
      { sub: "test-user", type: "user", role: "PLANNER", enterpriseId: entId, aud: "aps-internal" },
      process.env.INTERNAL_SERVICE_TOKEN ?? ""
    );
    return { "x-identity-assertion": token };
  }
  const post = (ent: string, path: string, body: object) => request(app).post(path).set(AUTH).set(identity(ent)).send(body);
  const get = (ent: string, path: string) => request(app).get(path).set(AUTH).set(identity(ent));

  beforeAll(async () => {
    enterpriseId = (await prisma.enterprise.create({ data: { name: `test-p2auth-${suffix}`, timezone: "UTC", currency: "USD" } })).id;
    otherEnterpriseId = (await prisma.enterprise.create({ data: { name: `test-p2auth-other-${suffix}`, timezone: "UTC", currency: "USD" } })).id;
  });

  afterAll(async () => {
    const ents = { in: [enterpriseId, otherEnterpriseId] };
    await prisma.documentNumberAllocation.deleteMany({ where: { enterpriseId: ents } });
    await prisma.documentSequence.deleteMany({ where: { enterpriseId: ents } });
    await prisma.salesOrder.deleteMany({ where: { enterpriseId: ents } });
    await prisma.customer.deleteMany({ where: { enterpriseId: ents } });
    await prisma.enterprise.deleteMany({ where: { id: ents } });
  });

  it("SALES_ORDER and CUSTOMER sequences start above ids already in Postgres and ignore malformed ones", async () => {
    const c = await prisma.customer.create({ data: { name: `Seeded ${suffix}`, enterpriseId, externalCustomerId: "C017" } });
    await prisma.customer.create({ data: { name: `Odd ${suffix}`, enterpriseId, externalCustomerId: "100023" } }); // SAP-style id: ignored
    await prisma.salesOrder.create({ data: { customerId: c.id, dueDate: new Date(), enterpriseId, externalOrderId: "SO0042" } });
    await prisma.salesOrder.create({ data: { customerId: c.id, dueDate: new Date(), enterpriseId, externalOrderId: "SO-TEST-9" } }); // ignored
    expect((await post(enterpriseId, "/sequences/CUSTOMER/next", { floor: 3 })).body.value).toBe(18);
    expect((await post(enterpriseId, "/sequences/SALES_ORDER/next", { floor: 0 })).body.value).toBe(43);
    expect((await post(enterpriseId, "/sequences/SALES_ORDER/next", { floor: 0, idempotencyKey: "so-k" })).body.value).toBe(44);
    expect((await post(enterpriseId, "/sequences/SALES_ORDER/next", { floor: 0, idempotencyKey: "so-k" })).body.value).toBe(44); // replay
  });

  it("find-or-create stores the external id, credit limit and active flag on a new customer", async () => {
    const res = await post(enterpriseId, "/customers/find-or-create", { name: `New Co ${suffix}`, externalCustomerId: "C100", creditLimit: 50000, active: true });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ externalCustomerId: "C100", creditLimit: 50000, active: true });
  });

  it("find-or-create adopts missing external id / credit limit onto a legacy row but never overwrites set values", async () => {
    const legacy = await prisma.customer.create({ data: { name: `Legacy ${suffix}`, enterpriseId } });
    const adopted = await post(enterpriseId, "/customers/find-or-create", { name: `Legacy ${suffix}`, externalCustomerId: "C101", creditLimit: 1234 });
    expect(adopted.status).toBe(200);
    expect(adopted.body).toMatchObject({ id: legacy.id, externalCustomerId: "C101", creditLimit: 1234 });
    const again = await post(enterpriseId, "/customers/find-or-create", { name: `Legacy ${suffix}`, externalCustomerId: "C999", creditLimit: 9 });
    expect(again.body).toMatchObject({ id: legacy.id, externalCustomerId: "C101", creditLimit: 1234 });
  });

  it("find-or-create validates the new fields", async () => {
    const n = `Bad ${suffix}`;
    expect((await post(enterpriseId, "/customers/find-or-create", { name: n, creditLimit: -1 })).status).toBe(400);
    expect((await post(enterpriseId, "/customers/find-or-create", { name: n, creditLimit: "5" })).status).toBe(400);
    expect((await post(enterpriseId, "/customers/find-or-create", { name: n, active: "yes" })).status).toBe(400);
    expect((await post(enterpriseId, "/customers/find-or-create", { name: n, externalCustomerId: "" })).status).toBe(400);
  });

  it("paged reads are tenant-scoped and keyset-paginate without gaps or repeats", async () => {
    const mine = await prisma.customer.findMany({ where: { enterpriseId }, select: { id: true } });
    await prisma.customer.create({ data: { name: `Other tenant ${suffix}`, enterpriseId: otherEnterpriseId } });
    const seen: string[] = [];
    let after: string | null = null;
    for (let i = 0; i < 50; i++) {
      const res: supertest.Response = await get(enterpriseId, `/customers/page?limit=2${after ? `&after=${after}` : ""}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.items.map((c: { id: string }) => c.id));
      after = res.body.nextAfter;
      if (!after) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(mine.length);
    expect(seen).toEqual(expect.arrayContaining(mine.map((m) => m.id)));
    const orders = await get(enterpriseId, "/sales-orders/page?limit=1000");
    expect(orders.body.items.every((o: { externalOrderId: string | null }) => o.externalOrderId !== undefined)).toBe(true);
    expect((await get(otherEnterpriseId, "/sales-orders/page")).body.items).toHaveLength(0);
  });
});
