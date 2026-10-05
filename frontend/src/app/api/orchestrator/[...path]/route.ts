import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

// Auth/Authz hardening, Phase 1 (Finding 1.2) — previously the browser
// called agent-orchestrator directly (NEXT_PUBLIC_API_BASE_URL), so
// nothing about Ledger's own auth (added this same phase, see proxy.ts)
// could ever apply to it — a real gap even once Ledger had a login, since
// the login would gate Ledger's *pages* but not this direct network path.
// This route is the fix: the browser now calls Ledger's own server (this
// route, same-origin, already covered by proxy.ts's session check), which
// forwards to agent-orchestrator with the shared internal-service token
// (proves the call came through this authenticated boundary, not directly)
// plus the real signed-in user's id/role (so agent-orchestrator's own
// require_user/require_role checks — see app/security.py — enforce
// against a real identity, not a client-supplied one). lib/api.ts now
// points at "/api/orchestrator" instead of the raw service URL.
const AGENT_ORCHESTRATOR_URL = process.env.AGENT_ORCHESTRATOR_URL ?? "http://localhost:8000";

async function proxy(req: Request, path: string[]) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const token = process.env.INTERNAL_SERVICE_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "Service misconfigured — internal auth token not set" }, { status: 500 });
  }

  const targetUrl = new URL(`${AGENT_ORCHESTRATOR_URL}/${path.join("/")}`);
  const incoming = new URL(req.url);
  targetUrl.search = incoming.search;

  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();

  const upstream = await fetch(targetUrl, {
    method: req.method,
    headers: {
      "content-type": "application/json",
      "x-internal-token": token,
      "x-forwarded-user": session.user.id,
      "x-forwarded-role": session.user.role,
    },
    body,
    cache: "no-store",
  });

  const responseBody = await upstream.text();
  return new NextResponse(responseBody, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
  });
}

export async function GET(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await params).path);
}

export async function POST(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await params).path);
}
