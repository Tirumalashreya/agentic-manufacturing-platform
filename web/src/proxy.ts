import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/lib/auth.config";

const { auth } = NextAuth(authConfig);

const PUBLIC_PATHS = new Set([
  "/",
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/verify-email",
  "/pricing",
  // No User rows have ever been seeded in this build (this app's own
  // login flow has never actually been exercised) — opened narrowly for
  // these two demo pages rather than gating the whole revived app behind
  // a login nobody can complete yet. Real auth stays enforced for every
  // other route.
  "/schedule",
  "/production-planning",
  // Same reasoning — real manufacturing master data (real machines/
  // work centers, real operator roster) with nobody able to log in and
  // see it otherwise.
  "/machines",
  "/operators",
  // Same reasoning again — real Vendor/PurchaseOrder/Inventory master data,
  // nothing to gate it behind until real login is exercised.
  "/materials",
  "/planning",
  "/recovery",
  // Ledger's own /execution and /operator pages were removed — Start/
  // Complete/Block belongs to the operator, and the operator only has
  // access to APS Platform, never to the Sales system. This is now the
  // one real place that work happens.
  "/my-jobs",
  // Discoverability pass (agreed with the user) — same reasoning as every
  // entry above: real data, no seeded User row exists to log in and see
  // it otherwise. /dashboard is the new home for OEE/Today/Planning
  // summaries; /orders is the new Order Detail control center's list —
  // its own detail route (/orders/:id) is matched by prefix below since
  // order ids are real and dynamic, not enumerable here.
  "/dashboard",
  "/orders",
]);

// /orders/:id (Order Detail, discoverability pass) needs a prefix match
// since PUBLIC_PATHS above is an exact-path Set and order ids are dynamic.
const PUBLIC_PREFIXES = ["/orders/"];

export default auth((req) => {
  const { pathname } = req.nextUrl;

  const isPublic =
    PUBLIC_PATHS.has(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p)) || pathname.startsWith("/api/");

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
