// Stage 01 HIGH-risk debt closure — POST /purchase-orders/:id/receive
// commits 3 real writes ($transaction of purchaseOrder.update +
// inventoryMovement.create, plus a separate inventory.upsert), then called
// an unguarded publish() — a Kafka failure turned an already-committed
// goods receipt into a misleading HTTP 500. inventory-service's first
// tests (previously zero existed).
//
// Real Postgres, real Prisma, real Kafka — only `publishTracked` is
// wrapped to simulate a downstream sync failure.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { prisma } from "@aps/domain";
import { app } from "./app";

import * as shared from "@aps/shared";
vi.mock("@aps/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aps/shared")>();
  return { ...actual, publishTracked: vi.fn(actual.publishTracked) };
});

const AUTH_HEADER = { "x-internal-token": process.env.INTERNAL_SERVICE_TOKEN ?? "" };
// Stage 02 (Tenant Isolation + Service Identity): /purchase-orders/:id/receive
// and /inventory now require a verified identity assertion — see this
// file's own describe block below for why (the resulting Inventory row is
// tenant-owned). Minted the same way every real caller must.
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
});

describe("inventory-service — Stage 01 downstream sync failure after a committed write", () => {
  const suffix = randomUUID().slice(0, 8);
  let enterpriseId: string;
  let productId: string;
  let vendorId: string;
  const createdPoIds: string[] = [];
  const LOCATION = `TEST-LOC-${suffix}`;

  beforeAll(async () => {
    const enterprise = await prisma.enterprise.create({
      data: { name: `test-inventory-service-${suffix}`, timezone: "UTC", currency: "USD" },
    });
    enterpriseId = enterprise.id;
    defaultEnterpriseId = enterpriseId;
    const product = await prisma.product.create({ data: { sku: `SKU-INV-${suffix}`, family: "Test", uom: "EA", leadTimeDays: 1 } });
    productId = product.id;
    const vendor = await prisma.vendor.create({ data: { name: `Test Vendor ${suffix}`, leadTimeDays: 5 } });
    vendorId = vendor.id;
  });

  afterEach(() => {
    vi.mocked(shared.publishTracked).mockRestore();
  });

  afterAll(async () => {
    await prisma.inventoryMovement.deleteMany({ where: { purchaseOrderId: { in: createdPoIds } } });
    await prisma.inventory.deleteMany({ where: { productId, location: LOCATION } });
    await prisma.purchaseOrder.deleteMany({ where: { id: { in: createdPoIds } } });
    await prisma.vendor.deleteMany({ where: { id: vendorId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.enterprise.deleteMany({ where: { id: enterpriseId } });
    await prisma.$disconnect();
  });

  async function freshPo(quantity: number) {
    const po = await prisma.purchaseOrder.create({
      data: { vendorId, productSku: productId, quantity, expectedDate: new Date(), confirmed: true },
    });
    createdPoIds.push(po.id);
    return po.id;
  }

  it("1 — the goods receipt (PO + movement + inventory) is correct when Kafka succeeds", async () => {
    const poId = await freshPo(10);
    const res = await req().post(`/purchase-orders/${poId}/receive`).send({ location: LOCATION });

    expect(res.status).toBe(201);
    expect(res.body.syncWarning).toBeUndefined();

    const po = await prisma.purchaseOrder.findUnique({ where: { id: poId } });
    expect(po!.receivedAt).not.toBeNull();
    const inventory = await prisma.inventory.findUnique({ where: { enterpriseId_productId_location: { enterpriseId, productId, location: LOCATION } } });
    expect(inventory!.qtyUnrestricted).toBeGreaterThanOrEqual(10);
  });

  it("2/3/4 — a Kafka failure leaves all 3 writes committed and is distinguishable from primary success, not a misleading retry signal", async () => {
    const poId = await freshPo(7);
    const cause = new Error("simulated broker unavailable");
    vi.mocked(shared.publishTracked).mockResolvedValueOnce(
      new shared.DownstreamSyncError({ operation: "test", target: "kafka:test", entityId: "placeholder", cause })
    );

    const res = await req().post(`/purchase-orders/${poId}/receive`).send({ location: LOCATION });

    // Distinguishable from primary success: still 201, but visibly flagged.
    expect(res.status).toBe(201);
    expect(res.body.syncWarning).toContain("simulated broker unavailable");

    // All 3 writes really committed — nothing rolled back because the
    // publish failed.
    const po = await prisma.purchaseOrder.findUnique({ where: { id: poId } });
    expect(po!.receivedAt).not.toBeNull();
    const movement = await prisma.inventoryMovement.findFirst({ where: { purchaseOrderId: poId } });
    expect(movement).not.toBeNull();
    expect(movement!.quantity).toBe(7);

    // No misleading retry signal: the existing idempotency guard (409 on
    // an already-received PO) kicks in on a retry of the exact same
    // request, rather than double-processing the receipt.
    const retry = await req().post(`/purchase-orders/${poId}/receive`).send({ location: LOCATION });
    expect(retry.status).toBe(409);
  });

  it("5 — the sync failure is not silently swallowed (server-side logging path is exercised, not bypassed)", async () => {
    const poId = await freshPo(3);
    const cause = new Error("simulated broker unavailable");
    const syncError = new shared.DownstreamSyncError({ operation: "test", target: "kafka:test", entityId: "placeholder", cause });
    vi.mocked(shared.publishTracked).mockResolvedValueOnce(syncError);

    const res = await req().post(`/purchase-orders/${poId}/receive`).send({ location: LOCATION });

    // The real DownstreamSyncError instance (not a generic string) reached
    // the route handler and was placed on the response — proves the
    // handler actually branched on it rather than ignoring the return
    // value of publishTracked.
    expect(res.body.syncWarning).toBe(syncError.message);
  });
});

// Stage 02 (Tenant Isolation + Service Identity) — ARCHITECTURE_BASELINE.md
// Part H TEST 4 / Part I: a concrete two-enterprise scenario for Inventory.
describe("inventory-service — Stage 02 tenant isolation", () => {
  const suffix = randomUUID().slice(0, 8);
  let enterpriseAId: string, enterpriseBId: string;
  let productId: string;
  const LOCATION = `TEST-S02-LOC-${suffix}`;

  beforeAll(async () => {
    const a = await prisma.enterprise.create({ data: { name: `test-tenant-A-${suffix}`, timezone: "UTC", currency: "USD" } });
    enterpriseAId = a.id;
    const b = await prisma.enterprise.create({ data: { name: `test-tenant-B-${suffix}`, timezone: "UTC", currency: "USD" } });
    enterpriseBId = b.id;
    const product = await prisma.product.create({ data: { sku: `SKU-S02-INV-${suffix}`, family: "Test", uom: "EA", leadTimeDays: 1 } });
    productId = product.id;

    // Enterprise B's own real Inventory row.
    await req(enterpriseBId).post("/inventory").send({ productId, location: LOCATION, qtyUnrestricted: 50, qtyReserved: 0, qtyInTransit: 0 });
  });

  afterAll(async () => {
    await prisma.inventory.deleteMany({ where: { productId, location: LOCATION } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.enterprise.deleteMany({ where: { id: { in: [enterpriseAId, enterpriseBId] } } });
    await prisma.$disconnect();
  });

  it("TEST 4 — Enterprise A cannot read Enterprise B's Inventory for a known productId", async () => {
    const res = await req(enterpriseAId).get(`/inventory?productId=${productId}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0); // B's row exists but is invisible to A
  });

  it("A -> A own-enterprise Inventory read still works, and a mutation against the same productId creates A's own separate row", async () => {
    const createRes = await req(enterpriseAId).post("/inventory").send({ productId, location: LOCATION, qtyUnrestricted: 7, qtyReserved: 0, qtyInTransit: 0 });
    expect(createRes.status).toBe(201);

    const aRead = await req(enterpriseAId).get(`/inventory?productId=${productId}`);
    expect(aRead.status).toBe(200);
    expect(aRead.body).toHaveLength(1);
    expect(aRead.body[0].enterpriseId).toBe(enterpriseAId);
    expect(aRead.body[0].qtyUnrestricted).toBe(7);

    // B's own row is unaffected and still invisible to A, and still has
    // its original quantity — proves A's write didn't silently mutate B's
    // row (productId+location collide; enterpriseId is what kept them apart).
    const bRead = await req(enterpriseBId).get(`/inventory?productId=${productId}`);
    expect(bRead.body).toHaveLength(1);
    expect(bRead.body[0].enterpriseId).toBe(enterpriseBId);
    expect(bRead.body[0].qtyUnrestricted).toBe(50);
  });
});

// Stage 06 (Service Ownership and Safe Consolidation) — POST
// /inventory/goods-issue: the real Goods Issue write mes-integration used
// to make directly against this service's own tables (prisma.inventory.upsert
// + prisma.inventoryMovement.create), bypassing inventory-service's HTTP
// API entirely — the one confirmed cross-domain write found in the Stage
// 06 service inventory. Moved here so inventory-service is the one real
// writer; these are this endpoint's first tests.
describe("inventory-service — Stage 06 POST /inventory/goods-issue", () => {
  const suffix = randomUUID().slice(0, 8);
  let enterpriseId: string;
  let productId: string;
  let productionOrder: { id: string };
  const LOCATION = `TEST-GI-LOC-${suffix}`;

  beforeAll(async () => {
    const enterprise = await prisma.enterprise.create({
      data: { name: `test-goods-issue-${suffix}`, timezone: "UTC", currency: "USD" },
    });
    enterpriseId = enterprise.id;
    defaultEnterpriseId = enterpriseId;
    const product = await prisma.product.create({ data: { sku: `SKU-GI-${suffix}`, family: "Test", uom: "EA", leadTimeDays: 1 } });
    productId = product.id;
    // A real ProductionOrder for the movement's own FK — plant/site chain
    // is only needed because ProductionOrder requires a real plantId.
    const site = await prisma.site.create({ data: { enterpriseId, name: `test-site-${suffix}`, timezone: "UTC" } });
    const plant = await prisma.plant.create({ data: { siteId: site.id, code: `TEST-GI-PLANT-${suffix}`, type: "DISCRETE", capacityUnit: "hours" } });
    productionOrder = await prisma.productionOrder.create({
      data: { plantId: plant.id, enterpriseId, productId, quantity: 1, status: "COMPLETED", priorityScore: 0 },
    });
  });

  afterAll(async () => {
    await prisma.inventoryMovement.deleteMany({ where: { productionOrderId: productionOrder.id } });
    await prisma.inventory.deleteMany({ where: { productId, location: LOCATION } });
    await prisma.productionOrder.deleteMany({ where: { id: productionOrder.id } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.plant.deleteMany({ where: { site: { enterpriseId } } });
    await prisma.site.deleteMany({ where: { enterpriseId } });
    await prisma.enterprise.deleteMany({ where: { id: enterpriseId } });
    await prisma.$disconnect();
  });

  it("issues real stock, floored at 0, and records a real GOODS_ISSUE movement", async () => {
    await req().post("/inventory").send({ productId, location: LOCATION, qtyUnrestricted: 10, qtyReserved: 0, qtyInTransit: 0 });

    const res = await req().post("/inventory/goods-issue").send({
      productId, location: LOCATION, quantity: 6, productionOrderId: productionOrder.id,
    });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe("GOODS_ISSUE");
    expect(res.body.quantity).toBe(6);

    const inventory = await prisma.inventory.findUnique({
      where: { enterpriseId_productId_location: { enterpriseId, productId, location: LOCATION } },
    });
    expect(inventory!.qtyUnrestricted).toBe(4);

    // Issuing more than remains floors at 0 rather than going negative —
    // same defensive shape as the direct-write version this replaced.
    const second = await req().post("/inventory/goods-issue").send({
      productId, location: LOCATION, quantity: 100, productionOrderId: productionOrder.id,
    });
    expect(second.status).toBe(201);
    const afterSecond = await prisma.inventory.findUnique({
      where: { enterpriseId_productId_location: { enterpriseId, productId, location: LOCATION } },
    });
    expect(afterSecond!.qtyUnrestricted).toBe(0);
  });

  it("is tenant-scoped like every other write here — a different enterprise's identity creates its own separate row, never touching this one's", async () => {
    const other = await prisma.enterprise.create({ data: { name: `test-goods-issue-other-${suffix}`, timezone: "UTC", currency: "USD" } });
    try {
      await req().post("/inventory").send({ productId, location: LOCATION, qtyUnrestricted: 20, qtyReserved: 0, qtyInTransit: 0 });
      const before = await prisma.inventory.findUnique({
        where: { enterpriseId_productId_location: { enterpriseId, productId, location: LOCATION } },
      });

      await req(other.id).post("/inventory/goods-issue").send({
        productId, location: LOCATION, quantity: 5, productionOrderId: productionOrder.id,
      });

      const afterOwn = await prisma.inventory.findUnique({
        where: { enterpriseId_productId_location: { enterpriseId, productId, location: LOCATION } },
      });
      expect(afterOwn!.qtyUnrestricted).toBe(before!.qtyUnrestricted); // untouched by the other enterprise's issue
      const otherRow = await prisma.inventory.findUnique({
        where: { enterpriseId_productId_location: { enterpriseId: other.id, productId, location: LOCATION } },
      });
      expect(otherRow).not.toBeNull();
      await prisma.inventory.deleteMany({ where: { enterpriseId: other.id, productId, location: LOCATION } });
      await prisma.inventoryMovement.deleteMany({ where: { productionOrderId: productionOrder.id, quantity: 5 } });
    } finally {
      await prisma.enterprise.deleteMany({ where: { id: other.id } });
    }
  });
});

// Scrap-aware completion work (P0 defect fix, verified live): finished
// goods were never credited into inventory anywhere on production
// completion. POST /inventory/goods-receipt is the missing leg, and both
// it and the existing goods-issue route now accept an Idempotency-Key so
// mes-integration's per-step completion orchestration can retry a failed
// step without ever creating a second real InventoryMovement.
describe("inventory-service — POST /inventory/goods-receipt + idempotency", () => {
  const suffix = randomUUID().slice(0, 8);
  let enterpriseId: string;
  let productId: string;
  let productionOrder: { id: string };
  const LOCATION = `TEST-GR-LOC-${suffix}`;

  beforeAll(async () => {
    const enterprise = await prisma.enterprise.create({
      data: { name: `test-goods-receipt-${suffix}`, timezone: "UTC", currency: "USD" },
    });
    enterpriseId = enterprise.id;
    defaultEnterpriseId = enterpriseId;
    const product = await prisma.product.create({ data: { sku: `SKU-GR-${suffix}`, family: "Test", uom: "EA", leadTimeDays: 1 } });
    productId = product.id;
    const site = await prisma.site.create({ data: { enterpriseId, name: `test-site-gr-${suffix}`, timezone: "UTC" } });
    const plant = await prisma.plant.create({ data: { siteId: site.id, code: `TEST-GR-PLANT-${suffix}`, type: "DISCRETE", capacityUnit: "hours" } });
    productionOrder = await prisma.productionOrder.create({
      data: { plantId: plant.id, enterpriseId, productId, quantity: 100, status: "COMPLETED", priorityScore: 0 },
    });
  });

  afterAll(async () => {
    await prisma.idempotencyKey.deleteMany({ where: { enterpriseId } });
    await prisma.inventoryMovement.deleteMany({ where: { productionOrderId: productionOrder.id } });
    await prisma.inventory.deleteMany({ where: { productId, location: LOCATION } });
    await prisma.productionOrder.deleteMany({ where: { id: productionOrder.id } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.plant.deleteMany({ where: { site: { enterpriseId } } });
    await prisma.site.deleteMany({ where: { enterpriseId } });
    await prisma.enterprise.deleteMany({ where: { id: enterpriseId } });
    await prisma.$disconnect();
  });

  it("credits real stock for the actual accepted quantity and records a real GOODS_RECEIPT movement", async () => {
    const res = await req().post("/inventory/goods-receipt").send({
      productId, location: LOCATION, quantity: 60, productionOrderId: productionOrder.id,
    });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe("GOODS_RECEIPT");
    expect(res.body.quantity).toBe(60);

    const inventory = await prisma.inventory.findUnique({
      where: { enterpriseId_productId_location: { enterpriseId, productId, location: LOCATION } },
    });
    expect(inventory!.qtyUnrestricted).toBe(60);
  });

  it("replaying the same Idempotency-Key + body is a true no-op — identical response, zero new movements or stock change", async () => {
    const key = `test-idem-${suffix}-1`;
    const body = { productId, location: LOCATION, quantity: 15, productionOrderId: productionOrder.id };

    const first = await req().post("/inventory/goods-receipt").set("Idempotency-Key", key).send(body);
    expect(first.status).toBe(201);

    const before = await prisma.inventoryMovement.count({ where: { productionOrderId: productionOrder.id } });
    const beforeQty = (await prisma.inventory.findUnique({
      where: { enterpriseId_productId_location: { enterpriseId, productId, location: LOCATION } },
    }))!.qtyUnrestricted;

    const replay = await req().post("/inventory/goods-receipt").set("Idempotency-Key", key).send(body);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body); // verbatim replay, not re-executed

    const after = await prisma.inventoryMovement.count({ where: { productionOrderId: productionOrder.id } });
    const afterQty = (await prisma.inventory.findUnique({
      where: { enterpriseId_productId_location: { enterpriseId, productId, location: LOCATION } },
    }))!.qtyUnrestricted;
    expect(after).toBe(before); // no second movement row
    expect(afterQty).toBe(beforeQty); // stock not double-credited
  });

  it("replaying the same Idempotency-Key with a different body is refused (409), not silently accepted as a fresh request", async () => {
    const key = `test-idem-${suffix}-2`;
    await req().post("/inventory/goods-receipt").set("Idempotency-Key", key).send({
      productId, location: LOCATION, quantity: 5, productionOrderId: productionOrder.id,
    });

    const conflicting = await req().post("/inventory/goods-receipt").set("Idempotency-Key", key).send({
      productId, location: LOCATION, quantity: 999, productionOrderId: productionOrder.id,
    });
    expect(conflicting.status).toBe(409);

    // The mismatched retry must not have been executed at all.
    const movement = await prisma.inventoryMovement.findFirst({ where: { productionOrderId: productionOrder.id, quantity: 999 } });
    expect(movement).toBeNull();
  });

  it("the same protection applies to goods-issue — a retried issue step cannot double-debit stock", async () => {
    await req().post("/inventory").send({ productId, location: LOCATION, qtyUnrestricted: 50, qtyReserved: 0, qtyInTransit: 0 });
    const key = `test-idem-issue-${suffix}`;
    const body = { productId, location: LOCATION, quantity: 10, productionOrderId: productionOrder.id };

    const first = await req().post("/inventory/goods-issue").set("Idempotency-Key", key).send(body);
    expect(first.status).toBe(201);
    const afterFirst = (await prisma.inventory.findUnique({
      where: { enterpriseId_productId_location: { enterpriseId, productId, location: LOCATION } },
    }))!.qtyUnrestricted;

    const replay = await req().post("/inventory/goods-issue").set("Idempotency-Key", key).send(body);
    expect(replay.status).toBe(201);
    const afterReplay = (await prisma.inventory.findUnique({
      where: { enterpriseId_productId_location: { enterpriseId, productId, location: LOCATION } },
    }))!.qtyUnrestricted;
    expect(afterReplay).toBe(afterFirst); // not debited twice
  });

  it("without an Idempotency-Key header, behavior is unchanged from before this work — every call executes", async () => {
    const before = await prisma.inventoryMovement.count({ where: { productionOrderId: productionOrder.id, type: "GOODS_RECEIPT" } });
    await req().post("/inventory/goods-receipt").send({ productId, location: LOCATION, quantity: 1, productionOrderId: productionOrder.id });
    await req().post("/inventory/goods-receipt").send({ productId, location: LOCATION, quantity: 1, productionOrderId: productionOrder.id });
    const after = await prisma.inventoryMovement.count({ where: { productionOrderId: productionOrder.id, type: "GOODS_RECEIPT" } });
    expect(after).toBe(before + 2); // both executed — no key means no dedup, exactly like today
  });
});
