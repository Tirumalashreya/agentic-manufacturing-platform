import { NextResponse } from "next/server";
import { apsAgent } from "@/lib/apsAgent";

// Phase 1 of the Ledger order-detail workspace (agreed with the user) —
// the "APS Status" tab's real capacity/bottleneck data. Delegates to the
// real APS Agent module (apsAgent.ts); same contract as before.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const plantId = searchParams.get("plantId");
  if (!plantId) {
    return NextResponse.json({ error: "plantId is required" }, { status: 400 });
  }
  try {
    const result = await apsAgent.getCapacityStatus(plantId);
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "scheduling-service unavailable" }, { status: 502 });
  }
}
