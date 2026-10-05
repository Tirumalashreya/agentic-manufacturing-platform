// One-off script: creates the Production Planning Agent's demo master data
// through the real service APIs (routing-service, machine-service,
// order-service) -- the same way the agent itself will create/read data,
// not a raw-SQL shortcut. Run once against a freshly migrated + seeded
// (packages/domain/prisma/seed.ts) database:
//
//   npx tsx scripts/seed-demo-master-data.ts
//
// Idempotent-ish: re-running will create duplicate rows (none of these
// endpoints upsert) -- only run it once per fresh database.

const ROUTING_SERVICE_URL = process.env.ROUTING_SERVICE_URL ?? "http://localhost:4002";
const MACHINE_SERVICE_URL = process.env.MACHINE_SERVICE_URL ?? "http://localhost:4008";
const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL ?? "http://localhost:4001";
const INVENTORY_SERVICE_URL = process.env.INVENTORY_SERVICE_URL ?? "http://localhost:4010";
const PLANT_CODE = "PLANT-01";

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function main() {
  // We need the seeded Plant's real id -- machine-service has no /plants
  // lookup (no service owns Plant reads either), so read it directly via
  // Prisma just this once, the same client packages/domain/prisma/seed.ts
  // already used.
  const { prisma } = await import("../packages/domain/src/index");
  const plant = await prisma.plant.findUniqueOrThrow({ where: { code: PLANT_CODE } });
  console.log("Using plant", plant.id, plant.code);

  // --- Products: the finished good + its 3 components ---
  const finished = await post<{ id: string }>(`${ROUTING_SERVICE_URL}/products`, {
    sku: "CMK-001", family: "Cable Management Kit", uom: "EA", leadTimeDays: 2, batchManaged: false,
  });
  const cableBody = await post<{ id: string }>(`${ROUTING_SERVICE_URL}/products`, {
    sku: "COMP-CABLE-BODY", family: "Cable Body", uom: "EA", leadTimeDays: 1, batchManaged: false,
  });
  const mountingClip = await post<{ id: string }>(`${ROUTING_SERVICE_URL}/products`, {
    sku: "COMP-MOUNTING-CLIP", family: "Mounting Clip", uom: "EA", leadTimeDays: 1, batchManaged: false,
  });
  const fastener = await post<{ id: string }>(`${ROUTING_SERVICE_URL}/products`, {
    sku: "COMP-FASTENER", family: "Fastener", uom: "EA", leadTimeDays: 1, batchManaged: false,
  });
  console.log("Products created:", { finished: finished.id, cableBody: cableBody.id, mountingClip: mountingClip.id, fastener: fastener.id });

  // --- BOM: same ratios already validated against the Python-side demo
  // (Cable Body x1, Mounting Clip x2, Fastener x4 per kit) ---
  const bom = await post<{ id: string }>(`${ROUTING_SERVICE_URL}/boms`, { productId: finished.id, version: "1", lotSize: 1 });
  await post(`${ROUTING_SERVICE_URL}/boms/${bom.id}/lines`, { componentId: cableBody.id, quantityPer: 1 });
  await post(`${ROUTING_SERVICE_URL}/boms/${bom.id}/lines`, { componentId: mountingClip.id, quantityPer: 2 });
  await post(`${ROUTING_SERVICE_URL}/boms/${bom.id}/lines`, { componentId: fastener.id, quantityPer: 4 });
  console.log("BOM created:", bom.id);

  // --- Work centers + machines ---
  const wcAssy = await post<{ id: string }>(`${MACHINE_SERVICE_URL}/work-centers`, {
    plantId: plant.id, code: "WC-ASSY", type: "MACHINE", efficiencyFactor: 1.0, workingDaysOfWeek: [1, 2, 3, 4, 5],
  });
  const wcPack = await post<{ id: string }>(`${MACHINE_SERVICE_URL}/work-centers`, {
    plantId: plant.id, code: "WC-PACK", type: "MACHINE", efficiencyFactor: 1.0, workingDaysOfWeek: [1, 2, 3, 4, 5],
  });
  // Each machine needs a MachineCapability row whose operationType exactly
  // matches a RoutingOperation.operation string (checkMachineCapability in
  // packages/domain/src/constraint-engine.ts does an exact string match) --
  // without this, scheduling-service's eligible-machine filter is empty for
  // every operation and nothing can ever be placed.
  const assyOps = ["Cut/Prep Cable Body", "Assemble", "Fasten"];
  const packOps = ["Pack/Inspect"];
  const machines: Record<string, string> = {};
  for (const [code, wc, ops] of [
    ["M-01", wcAssy, assyOps], ["M-02", wcAssy, assyOps], ["M-03", wcAssy, assyOps],
    ["M-04", wcPack, packOps], ["M-05", wcPack, packOps],
  ] as const) {
    const m = await post<{ id: string }>(`${MACHINE_SERVICE_URL}/machines`, {
      workCenterId: wc.id, name: code, type: "ASSEMBLY_LINE", ratedCapacity: 1,
    });
    for (const operationType of ops) {
      await post(`${MACHINE_SERVICE_URL}/machines/${m.id}/capabilities`, { operationType });
    }
    machines[code] = m.id;
  }
  console.log("Work centers + machines (+capabilities) created:", { wcAssy: wcAssy.id, wcPack: wcPack.id, machines });

  // --- Routing: OP-10 Cut/Prep -> OP-20 Assemble -> OP-30 Fasten -> OP-40 Pack/Inspect ---
  const routing = await post<{ id: string }>(`${ROUTING_SERVICE_URL}/routings`, { productId: finished.id, version: "1" });
  const op10 = await post<{ id: string }>(`${ROUTING_SERVICE_URL}/routings/${routing.id}/operations`, {
    opNumber: 10, operation: "Cut/Prep Cable Body", workCenterId: wcAssy.id, processingTimeMin: 5, setupTimeMin: 10,
  });
  const op20 = await post<{ id: string }>(`${ROUTING_SERVICE_URL}/routings/${routing.id}/operations`, {
    opNumber: 20, operation: "Assemble", workCenterId: wcAssy.id, processingTimeMin: 8, setupTimeMin: 5,
  });
  const op30 = await post<{ id: string }>(`${ROUTING_SERVICE_URL}/routings/${routing.id}/operations`, {
    opNumber: 30, operation: "Fasten", workCenterId: wcAssy.id, processingTimeMin: 6, setupTimeMin: 5,
  });
  const op40 = await post<{ id: string }>(`${ROUTING_SERVICE_URL}/routings/${routing.id}/operations`, {
    opNumber: 40, operation: "Pack/Inspect", workCenterId: wcPack.id, processingTimeMin: 4, setupTimeMin: 2, requiresInspection: true,
  });
  await post(`${ROUTING_SERVICE_URL}/operations/${op20.id}/predecessors`, { predecessorId: op10.id });
  await post(`${ROUTING_SERVICE_URL}/operations/${op30.id}/predecessors`, { predecessorId: op20.id });
  await post(`${ROUTING_SERVICE_URL}/operations/${op40.id}/predecessors`, { predecessorId: op30.id });
  console.log("Routing created:", { routing: routing.id, ops: [op10.id, op20.id, op30.id, op40.id] });

  // --- Inventory: components generously stocked except Fastener (70 --
  // enough for a 15-unit order (needs 60, PASS) but short for a 30-unit
  // order (needs 120, SHORTAGE 50) -- same pair already validated on the
  // Python side. Finished good itself has 0 stock, forcing MTO. ---
  await post(`${INVENTORY_SERVICE_URL}/inventory`, { productId: cableBody.id, location: PLANT_CODE, qtyUnrestricted: 500, qtyReserved: 0, qtyInTransit: 0 });
  await post(`${INVENTORY_SERVICE_URL}/inventory`, { productId: mountingClip.id, location: PLANT_CODE, qtyUnrestricted: 500, qtyReserved: 0, qtyInTransit: 0 });
  await post(`${INVENTORY_SERVICE_URL}/inventory`, { productId: fastener.id, location: PLANT_CODE, qtyUnrestricted: 70, qtyReserved: 0, qtyInTransit: 0 });
  await post(`${INVENTORY_SERVICE_URL}/inventory`, { productId: finished.id, location: PLANT_CODE, qtyUnrestricted: 0, qtyReserved: 0, qtyInTransit: 0 });
  console.log("Inventory seeded (Fastener=70, others generous, finished good=0)");

  // --- Customers ---
  const orion = await post<{ id: string }>(`${ORDER_SERVICE_URL}/customers`, { name: "Orion Systems", tier: "GOLD", slaDays: 14, penaltyPerDay: 500 });
  const vertex = await post<{ id: string }>(`${ORDER_SERVICE_URL}/customers`, { name: "Vertex Manufacturing", tier: "GOLD", slaDays: 14, penaltyPerDay: 500 });
  console.log("Customers created:", { orion: orion.id, vertex: vertex.id });

  console.log("\nDone. Product id (Cable Management Kit):", finished.id, " Plant id:", plant.id);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
