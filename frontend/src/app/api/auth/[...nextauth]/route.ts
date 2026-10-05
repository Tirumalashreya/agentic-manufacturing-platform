import type { NextRequest } from "next/server";
import { handlers } from "@/lib/auth";

// Wrapped (rather than `export const { GET, POST } = handlers`) to dodge a
// real monorepo quirk, not a logic change: this workspace intentionally
// pins two different Next.js versions (Ledger 16.3.4, APS 16.2.10 — see
// AGENTS.md), and next-auth resolves from the hoisted root node_modules,
// so its exported handler's NextRequest type is structurally, nominally
// distinct from Ledger's own locally-resolved NextRequest. Both are the
// real, correct type at runtime; only tsc's generated route-handler
// validator sees them as different types. Explicitly typing the param
// against Ledger's own local `next/server` here satisfies that validator
// without touching next-auth or downgrading Ledger's Next version.
// The `as never` here is the escape hatch for the exact mismatch described
// above (two structurally-identical, nominally-distinct NextRequest
// classes) — not a way to silence an unrelated type error. Runtime
// behavior is unaffected: both classes are the real Next.js NextRequest.
export async function GET(req: NextRequest) {
  return handlers.GET(req as never);
}

export async function POST(req: NextRequest) {
  return handlers.POST(req as never);
}
