import { prisma } from "@aps/domain";

async function main() {
  const enterprise = await prisma.enterprise.create({
    data: { name: "MaintVerify Co", timezone: "UTC", currency: "USD", tier: "STARTER" },
  });
  const site = await prisma.site.create({ data: { enterpriseId: enterprise.id, name: "Main", timezone: "UTC" } });
  const plant = await prisma.plant.create({ data: { siteId: site.id, code: "MAINT-P1", type: "DISCRETE", capacityUnit: "units/hr" } });
  const wc = await prisma.workCenter.create({ data: { plantId: plant.id, code: "WC-MAINT", type: "MACHINE", efficiencyFactor: 1 } });
  const machine = await prisma.machine.create({ data: { workCenterId: wc.id, name: "Maint Machine", type: "GENERIC", ratedCapacity: 10 } });
  await prisma.machineCapability.create({ data: { machineId: machine.id, operationType: "OP_MAINT" } });

  const product = await prisma.product.create({ data: { sku: "MAINT-SKU", family: "Verify", uom: "EA" } });
  const routing = await prisma.routing.create({ data: { productId: product.id, version: "A" } });
  await prisma.routingOperation.create({
    data: { routingId: routing.id, opNumber: 10, operation: "OP_MAINT", workCenterId: wc.id, processingTimeMin: 60, setupTimeMin: 0 },
  });

  console.log(JSON.stringify({ plantId: plant.id, machineId: machine.id, productId: product.id, routingId: routing.id }, null, 2));
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
