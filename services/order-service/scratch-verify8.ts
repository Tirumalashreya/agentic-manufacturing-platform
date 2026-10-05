import { prisma } from "@aps/domain";

async function main() {
  const customer = await prisma.customer.create({ data: { name: "MaintVerify Customer", tier: "GOLD", slaDays: 5, penaltyPerDay: 50 } });
  const so = await prisma.salesOrder.create({
    data: { customerId: customer.id, dueDate: new Date(Date.now() + 5 * 86_400_000), priority: 1, value: 500 },
  });
  const order = await prisma.productionOrder.create({
    data: {
      plantId: "cmrz7u0ez0002ao1dvzcx7ign",
      salesOrderId: so.id,
      productId: "cmrz7u0f70006ao1db9nl67ya",
      routingId: "cmrz7u0f80007ao1dhz4xayyt",
      quantity: 1,
      status: "PLANNED",
    },
  });
  console.log(JSON.stringify({ orderId: order.id }, null, 2));
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
