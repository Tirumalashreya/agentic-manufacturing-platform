import type { DefaultSession } from "next-auth";

type Role = "OWNER" | "ADMIN" | "PLANNER" | "VIEWER";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      enterpriseId: string | null;
      role: Role;
    } & DefaultSession["user"];
  }

  interface User {
    enterpriseId?: string | null;
    role?: Role;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    enterpriseId: string | null;
    role: Role;
  }
}
