import { prisma } from "@/lib/prisma";

// Wipes every plant-setup and scheduling record so a fresh Excel import can
// be tested end-to-end, without needing a hand-run scratch script each time
// (this is the real, general version of what packages/domain/_wipe_demo_data.ts
// did by matching specific demo-named rows — this deletes every row in every
// table below, full stop). Plant/Site/Enterprise/User and auth tokens are the
// only things left standing; everything else is rebuilt by the next import.
//
// Order matters: each deleteMany() runs only after every table that
// references it is already empty, so no FK constraint is ever violated
// regardless of whether the schema's onDelete behavior is Cascade or
// Restrict for a given relation. Kept explicit (rather than relying on
// cascade) so the order stays correct even if that changes later.
export async function clearAllData(): Promise<void> {
  await prisma.scheduleAuditLog.deleteMany();
  await prisma.changeoverMatrix.deleteMany();
  await prisma.schedule.deleteMany();
  await prisma.scheduleRun.deleteMany();

  await prisma.resourceReservation.deleteMany();
  await prisma.toolUsage.deleteMany();
  await prisma.sensorReading.deleteMany();
  await prisma.machineEvent.deleteMany();
  await prisma.maintenanceOrder.deleteMany();
  await prisma.maintenancePlan.deleteMany();
  await prisma.scheduledOperation.deleteMany();
  await prisma.productionOrderDependency.deleteMany();
  await prisma.productionOrder.deleteMany();
  await prisma.salesOrder.deleteMany();
  await prisma.customer.deleteMany();

  await prisma.routingOpDependency.deleteMany();
  await prisma.routingOperation.deleteMany();
  await prisma.bOMLine.deleteMany();
  await prisma.bOM.deleteMany();
  await prisma.inventory.deleteMany();
  await prisma.routing.deleteMany();
  await prisma.product.deleteMany();

  await prisma.purchaseOrder.deleteMany();
  await prisma.vendor.deleteMany();

  await prisma.machineCapability.deleteMany();
  await prisma.machine.deleteMany();

  await prisma.operatorSkill.deleteMany();
  await prisma.operatorShift.deleteMany();
  await prisma.operator.deleteMany();
  await prisma.skill.deleteMany();

  await prisma.workCenterShift.deleteMany();
  await prisma.shift.deleteMany();
  await prisma.workCenter.deleteMany();
  await prisma.productionLine.deleteMany();

  await prisma.factoryCalendarDay.deleteMany();
  await prisma.factoryCalendar.deleteMany();
  await prisma.holiday.deleteMany();
  await prisma.holidayCalendar.deleteMany();

  await prisma.tool.deleteMany();
}
