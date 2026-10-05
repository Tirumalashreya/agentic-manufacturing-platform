import { NextResponse } from "next/server";
import { apsAgent } from "@/lib/apsAgent";
import { requireSessionOrServiceCaller } from "@/lib/routeAuth";

// Real, committing — the one genuinely new APS Agent capability this
// milestone adds, buildable now that scheduling-service's SINGLE/AFFECTED
// scope actually narrows to real orders (see pipeline.ts's
// resolveScopedOrderIds) instead of silently rescheduling the whole
// plant. `scope` is REQUIRED and never defaults to ALL here — the caller
// (Ledger's Reschedule/Optimize buttons, or agent-orchestrator's
// reschedule node acting on a conversational request) always decides
// SINGLE vs AFFECTED explicitly before calling this route; this route
// itself never widens what was asked for.
export async function POST(req: Request) {
  const unauthorized = await requireSessionOrServiceCaller(req, "PLANNER");
  if (unauthorized) return unauthorized;

  const { plantId, productionOrderId, scope, mode } = (await req.json()) as {
    plantId: string;
    productionOrderId: string;
    scope: "SINGLE" | "AFFECTED";
    mode: "FORWARD" | "BACKWARD" | "BOTTLENECK";
  };
  if (scope !== "SINGLE" && scope !== "AFFECTED") {
    return NextResponse.json({ error: "scope must be SINGLE or AFFECTED — this route never reschedules the whole plant" }, { status: 422 });
  }
  try {
    const result = await apsAgent.reschedule({ plantId, productionOrderId, scope, mode });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "reschedule failed" }, { status: 502 });
  }
}
