"use server";

import { signOut } from "@/lib/auth";

// Extracted out of Topbar.tsx (agreed with the user) — Topbar needed to
// become a client component to read the current route via usePathname()
// for the page-title fix below, and an inline "use server" closure can't
// live inside a "use client" file, only a real server action module.
export async function signOutAction() {
  await signOut({ redirectTo: "/login" });
}
