import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import type { UserRole } from "@aps/domain";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { authConfig } from "@/lib/auth.config";

// Auth/Authz hardening, Phase 1 (Finding 1.6) — Ledger's own real
// authentication, added for the first time. Deliberately reuses the exact
// same `User` table APS Platform already authenticates against (both apps
// share one Postgres database via @aps/domain — see prisma.ts) rather than
// inventing a second, separate user store: one real account now works to
// log into both apps. No self-serve register/reset-password flow is added
// here (out of scope for this hardening phase — Ledger has no route for
// it yet); the one already-seeded account, or any created directly against
// the shared User table, can log in immediately.
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (credentials) => {
        const email = credentials?.email;
        const password = credentials?.password;
        if (typeof email !== "string" || typeof password !== "string") return null;

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) return null;

        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          enterpriseId: user.enterpriseId,
          role: user.role,
        };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.id = user.id as string;
        token.enterpriseId = (user.enterpriseId as string | null) ?? null;
        token.role = (user.role as UserRole | undefined) ?? "OWNER";
      }
      return token;
    },
    session({ session, token }) {
      session.user.id = token.id as string;
      session.user.enterpriseId = (token.enterpriseId as string | null) ?? null;
      session.user.role = (token.role as UserRole | undefined) ?? "OWNER";
      return session;
    },
  },
});
