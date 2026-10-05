import type { NextAuthConfig } from "next-auth";

// Auth/Authz hardening, Phase 1 (Finding 1.6) — Ledger had no authentication
// system at all before this. Mirrors APS Platform's identical file
// (web/src/lib/auth.config.ts) exactly: an edge-safe config middleware.ts
// can use to decode the session cookie without pulling in Prisma/bcrypt.
export const authConfig: NextAuthConfig = {
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [],
};
