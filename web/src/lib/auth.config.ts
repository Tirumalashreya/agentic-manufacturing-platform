import type { NextAuthConfig } from "next-auth";

// Edge-safe subset of the NextAuth config, used directly by proxy.ts. It only
// needs to decode the session cookie to answer "is this request authenticated"
// — no providers, no Prisma/bcrypt, no DB-dependent callbacks.
export const authConfig: NextAuthConfig = {
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [],
};
