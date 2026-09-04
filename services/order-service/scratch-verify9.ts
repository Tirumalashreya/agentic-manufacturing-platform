import bcrypt from "bcryptjs";
import { prisma } from "@aps/domain";

async function main() {
  const passwordHash = await bcrypt.hash("Password123!", 12);
  const enterprise = await prisma.enterprise.create({
    data: { name: "ImportVerify Co", timezone: "UTC", currency: "USD", tier: "STARTER" },
  });
  const site = await prisma.site.create({ data: { enterpriseId: enterprise.id, name: "Main", timezone: "UTC" } });
  const plant = await prisma.plant.create({ data: { siteId: site.id, code: "IMPORT-P1", type: "DISCRETE", capacityUnit: "units/hr" } });
  const user = await prisma.user.create({
    data: { name: "Import Tester", email: "import-verify@example.com", passwordHash, enterpriseId: enterprise.id, role: "OWNER", emailVerified: new Date() },
  });
  console.log(JSON.stringify({ enterpriseId: enterprise.id, plantId: plant.id, userId: user.id }, null, 2));
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
