import { prisma } from "./src/index";

const DEMO_CUSTOMERS = ["Titan Fluid Power", "Meridian Powertrain", "Atlas Industrial", "Redline Motorsports", "Coastal Machine Works", "Summit Fabrication"];
const DEMO_SKUS = ["HVB-100", "GBH-220", "PSH-310", "BFL-140", "MFB-405", "DCP-512", "SBR-088", "CTA-650"];
const DEMO_WORK_CENTERS = ["WC-MILL", "WC-LATHE", "WC-DRILL", "WC-GRIND", "WC-WELD", "WC-ASSY"];
const DEMO_MACHINE_NAMES = [
  "CNC Mill 1", "CNC Mill 2", "CNC Mill 3", "CNC Lathe 1", "CNC Lathe 2",
  "Drill Press 1", "Drill Press 2", "Surface Grinder 1", "Welding Station 1",
  "Welding Station 2", "Assembly Bench 1", "Inspection Station 1",
];
const DEMO_OPERATOR_EMPLOYEE_IDS = ["EMP-001","EMP-002","EMP-003","EMP-004","EMP-005","EMP-006","EMP-007","EMP-008"];
const DEMO_SHIFT_NAMES = ["Day Shift", "Evening Shift", "Weekend Shift"];
const DEMO_SKILL_NAMES = ["CNC Milling", "CNC Turning", "Drilling", "Grinding", "Welding", "Inspection", "Assembly"];

async function main() {
  // 1. Orders (+ scheduled ops + reservations) for the 6 demo customers.
  const orders = await prisma.productionOrder.findMany({
    where: { salesOrder: { customer: { name: { in: DEMO_CUSTOMERS } } } },
    select: { id: true, salesOrderId: true },
  });
  const orderIds = orders.map(o => o.id);
  const scheduledOps = await prisma.scheduledOperation.findMany({ where: { productionOrderId: { in: orderIds } }, select: { id: true } });
  const opIds = scheduledOps.map(o => o.id);
  await prisma.resourceReservation.deleteMany({ where: { scheduledOperationId: { in: opIds } } });
  await prisma.toolUsage.deleteMany({ where: { scheduledOperationId: { in: opIds } } });
  await prisma.scheduledOperation.deleteMany({ where: { id: { in: opIds } } });
  await prisma.productionOrderDependency.deleteMany({ where: { OR: [{ parentId: { in: orderIds } }, { childId: { in: orderIds } }] } });
  await prisma.productionOrder.deleteMany({ where: { id: { in: orderIds } } });
  const salesOrderIds = orders.map(o => o.salesOrderId).filter((id): id is string => !!id);
  await prisma.salesOrder.deleteMany({ where: { id: { in: salesOrderIds } } });
  console.log(`Deleted ${orderIds.length} orders, ${opIds.length} scheduled ops, ${salesOrderIds.length} sales orders`);

  // 2. Customers
  const custDel = await prisma.customer.deleteMany({ where: { name: { in: DEMO_CUSTOMERS } } });
  console.log("Deleted", custDel.count, "demo customers");

  // 3. Routing operations + dependencies + routings + products
  const routings = await prisma.routing.findMany({ where: { product: { sku: { in: DEMO_SKUS } } }, select: { id: true } });
  const routingIds = routings.map(r => r.id);
  const routingOps = await prisma.routingOperation.findMany({ where: { routingId: { in: routingIds } }, select: { id: true } });
  const routingOpIds = routingOps.map(o => o.id);
  await prisma.routingOpDependency.deleteMany({ where: { OR: [{ predecessorId: { in: routingOpIds } }, { successorId: { in: routingOpIds } }] } });
  await prisma.routingOperation.deleteMany({ where: { id: { in: routingOpIds } } });
  await prisma.routing.deleteMany({ where: { id: { in: routingIds } } });
  const prodDel = await prisma.product.deleteMany({ where: { sku: { in: DEMO_SKUS } } });
  console.log(`Deleted ${routingOpIds.length} routing ops, ${routingIds.length} routings, ${prodDel.count} products`);

  // 4. Machines (only the ones under the demo work centers, to avoid the
  // same-named old WC-MACH machines) + work centers
  const machines = await prisma.machine.findMany({
    where: { name: { in: DEMO_MACHINE_NAMES }, workCenter: { code: { in: DEMO_WORK_CENTERS } } },
    select: { id: true },
  });
  const machineIds = machines.map(m => m.id);
  await prisma.resourceReservation.deleteMany({ where: { machineId: { in: machineIds } } });
  await prisma.machineCapability.deleteMany({ where: { machineId: { in: machineIds } } });
  await prisma.machine.deleteMany({ where: { id: { in: machineIds } } });
  const wcDel = await prisma.workCenter.deleteMany({ where: { code: { in: DEMO_WORK_CENTERS } } });
  console.log(`Deleted ${machineIds.length} machines, ${wcDel.count} work centers`);

  // 5. Operators + shifts + skills
  const operators = await prisma.operator.findMany({ where: { employeeId: { in: DEMO_OPERATOR_EMPLOYEE_IDS } }, select: { id: true } });
  const operatorIds = operators.map(o => o.id);
  await prisma.resourceReservation.deleteMany({ where: { operatorId: { in: operatorIds } } });
  await prisma.operator.deleteMany({ where: { id: { in: operatorIds } } }); // OperatorSkill/OperatorShift cascade
  const shiftDel = await prisma.shift.deleteMany({ where: { name: { in: DEMO_SHIFT_NAMES } } });
  const skillDel = await prisma.skill.deleteMany({ where: { name: { in: DEMO_SKILL_NAMES } } });
  console.log(`Deleted ${operatorIds.length} operators, ${shiftDel.count} shifts, ${skillDel.count} skills`);

  console.log("\nDone.");
}
main().finally(() => prisma.$disconnect());
