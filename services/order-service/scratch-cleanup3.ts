import { prisma } from "@aps/domain";

async function main() {
  const plantId = "cmrz7u0ez0002ao1dvzcx7ign";
  const machineId = "cmrz7u0f30004ao1dett8ktjp";

  await prisma.resourceReservation.deleteMany({ where: { machineId } });
  await prisma.scheduledOperation.deleteMany({ where: { productionOrder: { plantId } } });
  await prisma.scheduleRun.deleteMany({ where: { plantId } });
  await prisma.schedule.deleteMany({ where: { plantId } });

  const orders = await prisma.productionOrder.findMany({ where: { plantId } });
  const salesOrderIds = orders.map((o) => o.salesOrderId).filter((id): id is string => id != null);
  await prisma.productionOrder.deleteMany({ where: { plantId } });
  await prisma.salesOrder.deleteMany({ where: { id: { in: salesOrderIds } } });
  await prisma.customer.deleteMany({ where: { name: "MaintVerify Customer" } });

  await prisma.maintenanceOrder.deleteMany({ where: { machineId } });
  await prisma.machineCapability.deleteMany({ where: { machineId } });
  await prisma.machine.deleteMany({ where: { workCenter: { plantId } } });
  await prisma.routingOperation.deleteMany({ where: { workCenter: { plantId } } });
  await prisma.workCenter.deleteMany({ where: { plantId } });

  const routing = await prisma.routing.findFirst({ where: { product: { sku: "MAINT-SKU" } } });
  if (routing) await prisma.routing.delete({ where: { id: routing.id } });
  await prisma.product.deleteMany({ where: { sku: "MAINT-SKU" } });

  const plant = await prisma.plant.findUnique({ where: { id: plantId } });
  const site = plant ? await prisma.site.findUnique({ where: { id: plant.siteId } }) : null;
  await prisma.plant.deleteMany({ where: { id: plantId } });
  if (site) {
    await prisma.site.deleteMany({ where: { id: site.id } });
    await prisma.enterprise.deleteMany({ where: { id: site.enterpriseId } });
  }

  console.log("cleanup3 done");
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
