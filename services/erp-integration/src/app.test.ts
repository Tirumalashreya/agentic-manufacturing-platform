// Stage 08 (Real ERP/MES Pilot Boundary) — erp-integration's first tests
// (previously none existed, and no test infra for this service either).
// Real Postgres, real Prisma — no mocking, matching this repo's own
// established convention. No identity/auth headers: this endpoint models
// an inbound ERP webhook, which this codebase deliberately does not gate
// behind internal service identity (see app.ts's own comment).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { prisma } from "@aps/domain";
import { app } from "./app";

const AUTH_HEADER = { "x-internal-token": process.env.INTERNAL_SERVICE_TOKEN ?? "" };

describe("erp-integration — POST /erp/idocs/orders05", () => {
  const suffix = randomUUID().slice(0, 8);
  const createdCustomerIds: string[] = [];
  const createdSalesOrderIds: string[] = [];

  const idoc = (overrides: Record<string, unknown> = {}) => ({
    externalCustomerId: `SAP-CUST-${suffix}`,
    customerName: `Test ERP Customer ${suffix}`,
    tier: "GOLD",
    slaDays: 10,
    penaltyPerDay: 50,
    dueDate: "2026-12-15",
    value: 4200,
    externalOrderId: `SAP-SO-${suffix}`,
    ...overrides,
  });

  afterAll(async () => {
    await prisma.salesOrder.deleteMany({ where: { id: { in: createdSalesOrderIds } } });
    await prisma.customer.deleteMany({ where: { id: { in: createdCustomerIds } } });
    await prisma.$disconnect();
  });

  it("creates a real Customer keyed by externalCustomerId, never by name", async () => {
    const res = await request(app).post("/erp/idocs/orders05").set(AUTH_HEADER).send(idoc());
    expect(res.status).toBe(201);
    expect(res.body.replay).toBe(false);
    createdSalesOrderIds.push(res.body.salesOrder.id);

    const customer = await prisma.customer.findFirst({ where: { externalCustomerId: `SAP-CUST-${suffix}` } });
    expect(customer).not.toBeNull();
    expect(customer!.id).not.toBe(`Test ERP Customer ${suffix}`); // id is never the business name
    createdCustomerIds.push(customer!.id);

    const order = await prisma.salesOrder.findUnique({ where: { id: res.body.salesOrder.id } });
    expect(order!.externalOrderId).toBe(`SAP-SO-${suffix}`);
  });

  it("redelivering the same IDoc (at-least-once delivery) is a no-op, not a duplicate SalesOrder", async () => {
    const before = await prisma.salesOrder.count({ where: { externalOrderId: `SAP-SO-${suffix}` } });
    const res = await request(app).post("/erp/idocs/orders05").set(AUTH_HEADER).send(idoc());
    expect(res.status).toBe(200);
    expect(res.body.replay).toBe(true);
    const after = await prisma.salesOrder.count({ where: { externalOrderId: `SAP-SO-${suffix}` } });
    expect(after).toBe(before); // no duplicate written
  });

  it("a second IDoc for the same external customer does not create a second Customer row", async () => {
    const res = await request(app).post("/erp/idocs/orders05").set(AUTH_HEADER).send(idoc({ externalOrderId: `SAP-SO-2-${suffix}` }));
    expect(res.status).toBe(201);
    createdSalesOrderIds.push(res.body.salesOrder.id);
    const customerCount = await prisma.customer.count({ where: { externalCustomerId: `SAP-CUST-${suffix}` } });
    expect(customerCount).toBe(1);
  });

  it("rejects a malformed IDoc with a clean 400 naming the missing field, not a raw 500", async () => {
    const res = await request(app).post("/erp/idocs/orders05").set(AUTH_HEADER).send(idoc({ externalOrderId: undefined }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/externalOrderId/);
  });

  it("rejects an invalid dueDate with a clean 400", async () => {
    const res = await request(app).post("/erp/idocs/orders05").set(AUTH_HEADER).send(idoc({ dueDate: "not-a-date", externalOrderId: `SAP-SO-3-${suffix}` }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/dueDate/);
  });

  it("GET /erp/reconciliation reports CLEAN when every row this channel owns has a real external id", async () => {
    const res = await request(app).get("/erp/reconciliation").set(AUTH_HEADER);
    expect(res.status).toBe(200);
    const ourCustomerGap = res.body.customersMissingExternalId.find((c: { id: string }) => createdCustomerIds.includes(c.id));
    const ourOrderGap = res.body.ordersMissingExternalId.find((o: { id: string }) => createdSalesOrderIds.includes(o.id));
    expect(ourCustomerGap).toBeUndefined();
    expect(ourOrderGap).toBeUndefined();
  });
});
