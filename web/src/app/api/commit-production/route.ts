import { NextResponse } from "next/server";
import { apsAgent } from "@/lib/apsAgent";
import { requireSessionOrServiceCaller } from "@/lib/routeAuth";

// The post-approval counterpart to /api/plan-production — same
// relocation reasoning: this used to be agent-orchestrator releasing the
// order and triggering the real scheduling run itself. Only ever called
// after a human has already approved on Ledger; nothing here makes that
// decision, it just carries out one already made. Delegates to the real
// APS Agent module (apsAgent.ts); same contract as before.
//
// Auth/Authz hardening, Phase 1 (Finding 1.5): this genuinely commits a
// real production order — previously callable by anyone.
export async function POST(req: Request) {
  const unauthorized = await requireSessionOrServiceCaller(req, "PLANNER");
  if (unauthorized) return unauthorized;

  const { productionOrderId, plantId, billingContext } = (await req.json()) as {
    productionOrderId: string;
    plantId: string;
    billingContext?: Record<string, unknown> | null;
  };
  const result = await apsAgent.commitProduction({ productionOrderId, plantId, billingContext });
  return NextResponse.json(result);
}
