import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import type { UserRole } from "@aps/domain";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { authConfig } from "@/lib/auth.config";

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
          emailVerified: user.emailVerified,
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
        token.emailVerified = user.emailVerified ?? null;
        token.enterpriseId = user.enterpriseId ?? null;
        token.role = (user.role as UserRole | undefined) ?? "OWNER";
      }
      return token;
    },
    // Tier/trialEndsAt are looked up live from Postgres (not cached on the
    // JWT) so an upgrade via upgradeTierAction takes effect immediately,
    // without needing a session-refresh round trip.
    async session({ session, token }) {
      session.user.id = token.id as string;
      session.user.emailVerified = (token.emailVerified as Date | null) ?? null;
      session.user.enterpriseId = (token.enterpriseId as string | null) ?? null;
      session.user.role = (token.role as UserRole | undefined) ?? "OWNER";

      if (session.user.enterpriseId) {
        const enterprise = await prisma.enterprise.findUnique({
          where: { id: session.user.enterpriseId },
          select: { tier: true, trialEndsAt: true },
        });
        session.user.tier = enterprise?.tier ?? "STARTER";
        session.user.trialEndsAt = enterprise?.trialEndsAt ?? null;
      } else {
        session.user.tier = "STARTER";
        session.user.trialEndsAt = null;
      }

      return session;
    },
  },
});
