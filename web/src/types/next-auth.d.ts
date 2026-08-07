import type { DefaultSession } from "next-auth";

type Role = "OWNER" | "ADMIN" | "PLANNER" | "VIEWER";
type Tier = "STARTER" | "PRO" | "ENTERPRISE";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      emailVerified: Date | null;
      enterpriseId: string | null;
      role: Role;
      tier: Tier;
      trialEndsAt: Date | null;
    } & DefaultSession["user"];
  }

  interface User {
    emailVerified?: Date | null;
    enterpriseId?: string | null;
    role?: Role;
    tier?: Tier;
    trialEndsAt?: Date | null;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    emailVerified: Date | null;
    enterpriseId: string | null;
    role: Role;
    tier: Tier;
    trialEndsAt: Date | null;
  }
}
