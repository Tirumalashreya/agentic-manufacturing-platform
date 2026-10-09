// Stage 01 HIGH-risk debt closure — ARCHITECTURE_BASELINE.md / Stage 01
// verification report: PATCH /machines/:id/status and POST
// /machines/:id/breakdown both committed a real write, then called an
// unguarded publish() — a Kafka failure turned an already-committed write
// into a misleading HTTP 500. These are machine-service's first tests
// (previously zero existed for this service).
//
// Real Postgres, real Prisma, real Kafka — no mocking of the DB or
// messaging layer, matching order-service's/scheduling-service's own
// established convention. Only `publishTracked` is wrapped so a downstream
// sync failure can be simulated without touching real Kafka connectivity.
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
  patch: (url: string) => request(app).patch(url).set(AUTH_HEADER),
  post: (url: string) => request(app).post(url).set(AUTH_HEADER),
});

describe("machine-service — Stage 01 downstream sync failure after a committed write", () => {
  const suffix = randomUUID().slice(0, 8);
  let enterpriseId: string;
  let workCenterId: string;
  let machineId: string;

  beforeAll(async () => {
    const enterprise = await prisma.enterprise.create({
      data: { name: `test-machine-service-${suffix}`, timezone: "UTC", currency: "USD" },
    });
    enterpriseId = enterprise.id;
    const site = await prisma.site.create({ data: { enterpriseId, name: `test-site-${suffix}`, timezone: "UTC" } });
    const plant = await prisma.plant.create({ data: { siteId: site.id, code: `TEST-MCH-${suffix}`, type: "DISCRETE", capacityUnit: "hours" } });
    const workCenter = await prisma.workCenter.create({
      data: { plantId: plant.id, code: `WC-MCH-${suffix}`, type: "MACHINE", workingDaysOfWeek: [1, 2, 3, 4, 5] },
    });
    workCenterId = workCenter.id;
    const machine = await prisma.machine.create({ data: { workCenterId, name: `M-${suffix}`, type: "CNC", ratedCapacity: 1 } });
    machineId = machine.id;
  });

  afterEach(() => {
    vi.mocked(shared.publishTracked).mockRestore();
  });

  afterAll(async () => {
    await prisma.machineEvent.deleteMany({ where: { machineId } });
    await prisma.machine.deleteMany({ where: { id: machineId } });
    await prisma.workCenter.deleteMany({ where: { id: workCenterId } });
    await prisma.enterprise.deleteMany({ where: { id: enterpriseId } });
    await prisma.$disconnect();
  });

  describe("PATCH /machines/:id/status", () => {
    it("1 — primary DB state is correct when Kafka succeeds", async () => {
      const res = await req().patch(`/machines/${machineId}/status`).send({ status: "RUNNING" });
      expect(res.status).toBe(200);
      expect(res.body.syncWarning).toBeUndefined();
      const persisted = await prisma.machine.findUnique({ where: { id: machineId } });
      expect(persisted!.status).toBe("RUNNING");
    });

    it("2/3/4/5 — a Kafka failure leaves the status committed, is not a false operation failure, is observable, and is not swallowed", async () => {
      const cause = new Error("simulated broker unavailable");
      vi.mocked(shared.publishTracked).mockResolvedValueOnce(
        new shared.DownstreamSyncError({ operation: "test", target: "kafka:test", entityId: machineId, cause })
      );

      const res = await req().patch(`/machines/${machineId}/status`).send({ status: "MAINTENANCE" });

      // 3: not a false failure — still a 200, not a 500.
      expect(res.status).toBe(200);
      // 4/5: observable, not silently dropped.
      expect(res.body.syncWarning).toContain("simulated broker unavailable");
      // 2: the primary DB write really committed despite the sync failure.
      const persisted = await prisma.machine.findUnique({ where: { id: machineId } });
      expect(persisted!.status).toBe("MAINTENANCE");
    });
  });

  describe("POST /machines/:id/breakdown", () => {
    it("1 — primary DB state (MachineEvent + status DOWN) is correct when Kafka succeeds", async () => {
      const res = await req().post(`/machines/${machineId}/breakdown`).send({ faultCode: "E-100", durationMinutes: 30 });
      expect(res.status).toBe(201);
      expect(res.body.syncWarning).toBeUndefined();
      const machine = await prisma.machine.findUnique({ where: { id: machineId } });
      expect(machine!.status).toBe("DOWN");
      const event = await prisma.machineEvent.findUnique({ where: { id: res.body.id } });
      expect(event).not.toBeNull();
      expect(event!.faultCode).toBe("E-100");
    });

    it("2/3/4/5 — a Kafka failure leaves the MachineEvent + DOWN status committed, is not a false operation failure, is observable, and is not swallowed", async () => {
      const cause = new Error("simulated broker unavailable");
      vi.mocked(shared.publishTracked).mockResolvedValueOnce(
        new shared.DownstreamSyncError({ operation: "test", target: "kafka:test", entityId: "placeholder", cause })
      );

      const res = await req().post(`/machines/${machineId}/breakdown`).send({ faultCode: "E-200", durationMinutes: 45 });

      // 3: not a false failure.
      expect(res.status).toBe(201);
      // 4/5: observable, not silently dropped.
      expect(res.body.syncWarning).toContain("simulated broker unavailable");
      // 2: both writes really committed — the scheduling/notification
      // reaction not firing is real, but the breakdown itself is not lost.
      const machine = await prisma.machine.findUnique({ where: { id: machineId } });
      expect(machine!.status).toBe("DOWN");
      const event = await prisma.machineEvent.findUnique({ where: { id: res.body.id } });
      expect(event).not.toBeNull();
      expect(event!.faultCode).toBe("E-200");
    });
  });
});
