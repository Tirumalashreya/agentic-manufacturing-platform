import { prisma } from "./src/index";
async function main() {
  const plants = await prisma.plant.findMany({ include: { site: { include: { enterprise: true } } } });
  console.log(JSON.stringify(plants, null, 2));
}
main().finally(() => prisma.$disconnect());
