import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/lib/auth.config";

const { auth } = NextAuth(authConfig);

// Auth/Authz hardening, Phase 1 (Finding 1.6) — Ledger had no route
// protection at all before this; every page and every client-side call to
// agent-orchestrator (see Finding 1.2, closed by the /api/orchestrator
// proxy route + lib/api.ts pointing at it instead of the raw service URL)
// was reachable by anyone. Deny-by-default, same shape as APS Platform's
// own proxy.ts — but Ledger does NOT inherit APS's "no seeded users yet"
// public-page carve-outs: both apps now authenticate against the exact
// same User table (see auth.ts), so that reasoning no longer applies here.
const PUBLIC_PATHS = new Set(["/login"]);

export default auth((req) => {
  const { pathname } = req.nextUrl;

  const isPublic = PUBLIC_PATHS.has(pathname) || pathname.startsWith("/api/auth/");

  if (isPublic || req.auth) {
    return NextResponse.next();
  }

  const loginUrl = new URL("/login", req.nextUrl.origin);
  loginUrl.searchParams.set("callbackUrl", pathname);
  return NextResponse.redirect(loginUrl);
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
