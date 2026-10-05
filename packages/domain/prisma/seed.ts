// Bootstraps the one thing no service owns: tenant/plant infra
// (Enterprise -> Site -> Plant). No service exposes CRUD for any of these
// three models (confirmed by grep across services/*/src) -- they're
// Customizing-style setup, not business data any service is responsible
// for, so a direct-Prisma seed is the right layer for them, same as any
// real ERP's initial system configuration. Business master data (Product/
// BOM/Routing/Machine/Inventory/Customer) is deliberately NOT seeded here
// -- that goes through routing-service/machine-service/order-service's own
// real APIs (see scripts/seed-demo-master-data.ts at the repo root), so
// the demo data is created the same way the Production Planning Agent
// itself would create it.
import { prisma } from "../src/index";

async function main() {
  const enterprise = await prisma.enterprise.upsert({
    where: { id: "seed-enterprise" },
    update: {},
    create: { id: "seed-enterprise", name: "Demo Manufacturing Co", timezone: "Asia/Kolkata", currency: "INR" },
  });

  const site = await prisma.site.upsert({
    where: { id: "seed-site" },
    update: {},
    create: { id: "seed-site", enterpriseId: enterprise.id, name: "Demo Site", timezone: "Asia/Kolkata" },
  });

  const plant = await prisma.plant.upsert({
    where: { code: "PLANT-01" },
    update: {},
    create: { siteId: site.id, code: "PLANT-01", type: "DISCRETE", capacityUnit: "hours" },
  });

  console.log("Seeded:", { enterpriseId: enterprise.id, siteId: site.id, plantId: plant.id, plantCode: plant.code });
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
