import { NextResponse } from "next/server";
import { apsAgent } from "@/lib/apsAgent";

// Phase 2 (agreed with the user): the What-if bridge. Real,
// non-committing — delegates to the real APS Agent module (apsAgent.ts);
// same contract as before. Untouched by the reschedule/AFFECTED work —
// no seed order is ever threaded into a what-if call.
export async function POST(req: Request) {
  const { plantId, productionOrderId, capacityAdjustments } = (await req.json()) as {
    plantId: string;
    productionOrderId: string;
    capacityAdjustments: { workCenterId: string; additionalMachineCount: number }[];
  };
  try {
    const result = await apsAgent.simulateWhatIf({ plantId, productionOrderId, capacityAdjustments });
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "scheduling-service what-if failed" }, { status: 502 });
  }
}
