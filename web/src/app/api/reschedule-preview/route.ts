import { NextResponse } from "next/server";
import { apsAgent } from "@/lib/apsAgent";

// Real, read-only — never commits anything. Lets a caller show a real
// target + real affected-order list BEFORE a reschedule is approved,
// using the exact same resolution scheduling-service's committing run
// itself uses (see pipeline.ts's resolveScopedOrderIds) — never a second,
// possibly-divergent definition of "affected." Used by the Agent
// Console's approval-gate preview for a conversational reschedule
// request, and available for Ledger's own pre-click preview.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const plantId = searchParams.get("plantId");
  const productionOrderId = searchParams.get("productionOrderId");
  const scope = searchParams.get("scope");
  if (!plantId || !productionOrderId || (scope !== "SINGLE" && scope !== "AFFECTED")) {
    return NextResponse.json({ error: "plantId, productionOrderId, and scope (SINGLE or AFFECTED) are required" }, { status: 400 });
  }
  try {
    const result = await apsAgent.resolveAffectedOrders({ plantId, productionOrderId, scope });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "affected-orders lookup failed" }, { status: 404 });
  }
}
