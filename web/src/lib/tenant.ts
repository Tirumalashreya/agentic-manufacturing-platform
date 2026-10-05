import { prisma } from "@/lib/prisma";

// Every plant lives under Plant -> Site -> Enterprise; Enterprise is the
// tenant boundary (see auth.ts / registerAction). Every page listing plants
// scopes through this helper so no query can accidentally cross tenants.
export function listPlantsForEnterprise(enterpriseId: string | null) {
  if (!enterpriseId) return Promise.resolve([]);
  return prisma.plant.findMany({
    where: { site: { enterpriseId } },
    include: { site: true },
    orderBy: { code: "asc" },
  });
}
