// Stage 01 HIGH-risk debt closure — POST /maintenance-orders committed a
// real write, then called an unguarded publish() — a Kafka failure turned
// an already-committed MaintenanceOrder into a misleading HTTP 500.
// maintenance-service's first tests (previously zero existed).
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
const req = () => ({
  post: (url: string) => request(app).post(url).set(AUTH_HEADER),
});

describe("maintenance-service — Stage 01 downstream sync failure after a committed write", () => {
  const suffix = randomUUID().slice(0, 8);
  let enterpriseId: string;
  let workCenterId: string;
  let machineId: string;
  const createdOrderIds: string[] = [];

  beforeAll(async () => {
    const enterprise = await prisma.enterprise.create({
      data: { name: `test-maintenance-service-${suffix}`, timezone: "UTC", currency: "USD" },
    });
    enterpriseId = enterprise.id;
    const site = await prisma.site.create({ data: { enterpriseId, name: `test-site-${suffix}`, timezone: "UTC" } });
    const plant = await prisma.plant.create({ data: { siteId: site.id, code: `TEST-MNT-${suffix}`, type: "DISCRETE", capacityUnit: "hours" } });
    const workCenter = await prisma.workCenter.create({
      data: { plantId: plant.id, code: `WC-MNT-${suffix}`, type: "MACHINE", workingDaysOfWeek: [1, 2, 3, 4, 5] },
    });
    workCenterId = workCenter.id;
    const machine = await prisma.machine.create({ data: { workCenterId, name: `M-${suffix}`, type: "CNC", ratedCapacity: 1 } });
    machineId = machine.id;
  });

  afterEach(() => {
    vi.mocked(shared.publishTracked).mockRestore();
  });

  afterAll(async () => {
    await prisma.maintenanceOrder.deleteMany({ where: { id: { in: createdOrderIds } } });
    await prisma.machine.deleteMany({ where: { id: machineId } });
    await prisma.workCenter.deleteMany({ where: { id: workCenterId } });
    await prisma.enterprise.deleteMany({ where: { id: enterpriseId } });
    await prisma.$disconnect();
  });

  it("1 — the maintenance order creation is correct and truthful when Kafka succeeds", async () => {
    const res = await req().post("/maintenance-orders").send({
      machineId, type: "PREVENTIVE", scheduledStart: "2026-11-01T08:00:00Z", scheduledEnd: "2026-11-01T10:00:00Z", priority: 0,
    });
    expect(res.status).toBe(201);
    expect(res.body.syncWarning).toBeUndefined();
    createdOrderIds.push(res.body.id);
    const persisted = await prisma.maintenanceOrder.findUnique({ where: { id: res.body.id } });
    expect(persisted).not.toBeNull();
    expect(persisted!.machineId).toBe(machineId);
  });

  it("2/3/4/5 — a Kafka failure does not falsely imply the write was rolled back, is observable, and is not swallowed", async () => {
    const cause = new Error("simulated broker unavailable");
    vi.mocked(shared.publishTracked).mockResolvedValueOnce(
      new shared.DownstreamSyncError({ operation: "test", target: "kafka:test", entityId: "placeholder", cause })
    );

    const res = await req().post("/maintenance-orders").send({
      machineId, type: "CORRECTIVE", scheduledStart: "2026-11-02T08:00:00Z", scheduledEnd: "2026-11-02T10:00:00Z", priority: 1,
    });

    // Not a false primary-operation failure.
    expect(res.status).toBe(201);
    createdOrderIds.push(res.body.id);
    // Observable, not silently swallowed.
    expect(res.body.syncWarning).toContain("simulated broker unavailable");
    // The real write committed — scheduling-service's BLOCKED reservation
    // not being created is a real downstream gap, but the maintenance
    // order itself is not lost or misrepresented as never having happened.
    const persisted = await prisma.maintenanceOrder.findUnique({ where: { id: res.body.id } });
    expect(persisted).not.toBeNull();
    expect(persisted!.type).toBe("CORRECTIVE");
  });
});
