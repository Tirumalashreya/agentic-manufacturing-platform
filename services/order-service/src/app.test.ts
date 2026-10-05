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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { prisma } from "@aps/domain";
import { app } from "./app";

// Real auth, same as every other real caller (requireServiceToken, mounted
// by createApp() on every non-health route) — no bypass for tests.
const AUTH_HEADER = { "x-internal-token": process.env.INTERNAL_SERVICE_TOKEN ?? "" };
const req = () => ({
  get: (url: string) => request(app).get(url).set(AUTH_HEADER),
  post: (url: string) => request(app).post(url).set(AUTH_HEADER),
  patch: (url: string) => request(app).patch(url).set(AUTH_HEADER),
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
    const site = await prisma.site.create({ data: { enterpriseId, name: `test-site-${suffix}`, timezone: "UTC" } });
    const plant = await prisma.plant.create({ data: { siteId: site.id, code: `TEST-ORDSVC-${suffix}`, type: "DISCRETE", capacityUnit: "hours" } });
    plantId = plant.id;
    const product = await prisma.product.create({ data: { sku: `SKU-ORDSVC-${suffix}`, family: "Test", uom: "EA", leadTimeDays: 1 } });
    productId = product.id;

    const customer = await prisma.customer.create({ data: { name: `Test Customer ${suffix}`, tier: "STANDARD", slaDays: 14, penaltyPerDay: 0 } });
    customerId = customer.id;
    createdCustomerIds.push(customerId);
  });

  afterAll(async () => {
    await prisma.fulfillmentLine.deleteMany({ where: { fulfillmentPlan: { orderLine: { orderId: { in: createdSalesOrderIds } } } } });
    await prisma.fulfillmentPlan.deleteMany({ where: { orderLine: { orderId: { in: createdSalesOrderIds } } } });
    await prisma.orderLine.deleteMany({ where: { orderId: { in: createdSalesOrderIds } } });
    await prisma.scheduledOperation.deleteMany({ where: { productionOrderId: { in: createdProductionOrderIds } } });
    await prisma.productionOrder.deleteMany({ where: { id: { in: createdProductionOrderIds } } });
    await prisma.salesOrder.deleteMany({ where: { id: { in: createdSalesOrderIds } } });
    await prisma.customer.deleteMany({ where: { id: { in: createdCustomerIds } } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.plant.deleteMany({ where: { id: plantId } });
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
});
