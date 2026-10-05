"use server";

import { AuthError } from "next-auth";
import { signIn } from "@/lib/auth";

// Auth/Authz hardening, Phase 1 (Finding 1.6) — Ledger's first real login.
// Mirrors APS Platform's identical loginAction shape.
export async function loginAction(email: string, password: string, callbackUrl: string) {
  if (!email || !password) {
    return { ok: false as const, formError: "Email and password are required." };
  }
  try {
    await signIn("credentials", { email, password, redirectTo: callbackUrl || "/" });
    return { ok: true as const };
  } catch (error) {
    if (error instanceof AuthError) {
      return { ok: false as const, formError: "Invalid email or password." };
    }
    throw error;
  }
}
