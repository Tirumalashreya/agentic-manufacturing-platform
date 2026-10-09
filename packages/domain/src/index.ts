import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Every service in services/* imports { prisma } from "@aps/domain" rather
// than constructing its own client — all services point at the same
// Postgres instance (§12 said polyglot-per-service; this machine runs one
// Postgres, so "each service owns its data" here means "owns its tables",
// not a physically separate database).
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export * from "../src/generated/prisma/client";
export * from "./priority-score";
export * from "./dispatch-rules";
export * from "./constraint-engine";
export * from "./capacity-engine";
export * from "./shift-expansion";
export * from "./scheduling-types";
export * from "./promise-risk";
