import { NextResponse } from "next/server";
import { apsAgent } from "@/lib/apsAgent";
import { requireSessionOrServiceCaller } from "@/lib/routeAuth";

// The real relocation asked for: this used to be agent-orchestrator
// (Ledger's backend) calling routing-service/inventory-service/
// order-service/scheduling-service/machine-service directly, computing
// the whole production plan itself. It's the exact same real calls to
// the exact same real services, just triggered from APS Platform now —
// Sales asks, Manufacturing plans. Still runs synchronously as part of
// the pre-approval flow (Ledger awaits this response before it can even
// show an approval screen), so the "nothing commits before a human
// approves" rule is untouched — only WHO does the planning moved, not
// WHEN relative to approval. The one thing deliberately NOT moved here:
// the plain-English verdict (PASS/WARNING/MATERIAL_SHORTAGE explanation)
// stays a Python/LangChain call on Ledger's side — this endpoint returns
// the real facts (materials, routing, schedule, shortage), and Ledger's
// own Production Planning Agent still renders judgment on top of them,
// same as it always has for every other real fact it's ever explained.
//
// The composition logic itself now lives in apsAgent.ts (the real APS
// Agent module) — this route is a thin delegate, same request/response
// contract as before.
// Auth/Authz hardening, Phase 1 (Finding 1.5): still pre-approval — any
// authenticated caller may explore a plan (matches pipeline.py's own
// require_user, not require_role, for the same "not yet a commitment"
// reasoning) — but no longer a fully anonymous one.
export async function POST(req: Request) {
  const unauthorized = await requireSessionOrServiceCaller(req, "VIEWER");
  if (unauthorized) return unauthorized;

  const { productId, productName, quantity, configurationNotes, idempotencyKey } = (await req.json()) as {
    productId: string;
    productName: string | null;
    quantity: number;
    requiredDate: string | null;
    configurationNotes: string | null;
    idempotencyKey?: string | null;
  };
  // Stage 07 (Observability/Correlation): agent-orchestrator forwards its
  // own run's trace_id on this call (see manufacturing_services.py's
  // _internal_headers) — relayed through to every TS service
  // planProduction itself calls, so the whole chain stays correlated
  // under one id, with no new identifier invented at this hop.
  const traceId = req.headers.get("x-trace-id");
  const result = await apsAgent.planProduction({ productId, productName, quantity, configurationNotes, idempotencyKey, traceId });
  return NextResponse.json(result);
}
