import { NextResponse } from "next/server";
import type { UserRole } from "@aps/domain";
import { auth } from "@/lib/auth";

// Auth/Authz hardening, Phase 1 (Finding 1.5): commit-production/reschedule/
// plan-production previously had no auth check at all — reachable by an
// anonymous POST despite being real, committing production actions.
//
// Two legitimate kinds of caller reach these routes, and this accepts
// either one:
// 1. A real APS user's own browser, already carrying a NextAuth session
//    cookie (e.g. Order Detail's Reschedule/Optimize buttons) — requires
//    the session AND a role of at least `minimum`.
// 2. agent-orchestrator, calling server-to-server after a human has
//    already approved the action at its own require_role("PLANNER") gate
//    (see approvals.py) — proven by the shared internal-service token,
//    not a second copy of role plumbing in a different language for the
//    same already-made decision.
const ROLE_RANK: Record<UserRole, number> = { VIEWER: 0, PLANNER: 1, ADMIN: 2, OWNER: 3 };

export async function requireSessionOrServiceCaller(
  req: Request,
  minimum: UserRole = "PLANNER"
): Promise<NextResponse | null> {
  const internalToken = req.headers.get("x-internal-token");
  const expectedToken = process.env.INTERNAL_SERVICE_TOKEN;
  if (internalToken && expectedToken && internalToken === expectedToken) {
    return null; // authorized: trusted server-to-server caller
  }

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  if (ROLE_RANK[session.user.role] < ROLE_RANK[minimum]) {
    return NextResponse.json({ error: `Requires ${minimum} role or higher` }, { status: 403 });
  }
  return null; // authorized: real session with sufficient role
}
