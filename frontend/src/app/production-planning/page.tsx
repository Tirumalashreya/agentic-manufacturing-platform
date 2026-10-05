import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { fetchDeviationAnalysis, fetchScrap } from "@/lib/services";
import { listPipelineRuns } from "@/lib/api";
import { Gauge } from "@/components/manufacturing/Gauge";
import { StageTracker } from "@/components/manufacturing/StageTracker";
import { PageHeader, Panel, StatusBadge, EmptyState } from "@/components/ui";

export const metadata: Metadata = { title: "Production Planning" };

const APS_PLATFORM_URL = process.env.NEXT_PUBLIC_APS_PLATFORM_URL ?? "http://localhost:3001";

function statusTone(status: string): "success" | "danger" | "warning" | "neutral" {
  if (status === "COMPLETED") return "success";
  if (status === "FAILED") return "danger";
  if (status === "RUNNING") return "warning";
  return "neutral";
}

// This is the PLAN page only — pre-commit decisions (what to build, from
// what materials, what verdict) plus the AI's own Plan History. Detailed
// timing/machine assignment and actually running the shop floor (Start/
// Complete, live per-operation status) both live on APS Platform now, a
// genuinely separate application — operator actions belong exclusively
// there, not duplicated here. Positions render as a real stage tracker
// (see StageTracker) driven by ProductionOrder.status, not a flat
// operations table — a planner cares where each order currently sits
// (Planned -> Released -> In Production -> Completed), not per-operation
// detail.
export default async function ProductionPlanningPage({
  searchParams,
}: {
  searchParams: Promise<{ plantId?: string }>;
}) {
  const { plantId: requestedPlantId } = await searchParams;
  const plants = await prisma.plant.findMany({ orderBy: { code: "asc" } });
  const selectedPlant = plants.find((p) => p.id === requestedPlantId) ?? plants[0];

  const runs = await listPipelineRuns();

  if (!selectedPlant) {
    return (
      <div>
        <PageHeader title="Production Planning" />
        <EmptyState title="No plants exist yet" description="Run the seed script first." />
      </div>
    );
  }

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000);

  const [positions, deviation, scrap] = await Promise.all([
    prisma.productionOrder.findMany({
      where: { plantId: selectedPlant.id },
      include: { product: true, salesOrder: { include: { customer: true } }, scheduledOperations: { select: { status: true } } },
      orderBy: { priorityScore: "desc" },
      take: 50,
    }),
    fetchDeviationAnalysis(selectedPlant.id),
    fetchScrap(thirtyDaysAgo.toISOString(), now.toISOString()),
  ]);

  return (
    <div>
      <PageHeader
        title="Production Planning"
        description={
          <>
            {selectedPlant.code} · plan only — see{" "}
            <a href={`${APS_PLATFORM_URL}/schedule`} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>Schedule ↗</a>{" "}
            for timing,{" "}
            <a href={`${APS_PLATFORM_URL}/my-jobs`} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>My Jobs ↗</a>{" "}
            for the shop floor, both on APS Platform
          </>
        }
      />

      <div style={{ display: "grid", gap: 20, gridTemplateColumns: "1fr 240px", alignItems: "start", marginTop: 18 }}>
        <div>
          <Panel title="Positions" subtitle="Where each order actually sits right now — not a snapshot, the real ProductionOrder.status." style={{ padding: 0, overflowX: "auto" }}>
            <div style={{ padding: "0 20px 16px" }}>
              <table className="grid">
                <thead>
                  <tr>
                    <th>Work Order</th><th>Prio</th><th>Item</th><th>Qty</th><th>Stage</th><th>Delivery</th><th>Customer</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.length === 0 ? (
                    <tr><td colSpan={7} style={{ textAlign: "center", color: "var(--text-soft)" }}>No production orders yet.</td></tr>
                  ) : (
                    positions.map((order) => {
                      const totalOps = order.scheduledOperations.length;
                      const doneOps = order.scheduledOperations.filter((o) => o.status === "DONE").length;
                      return (
                        <tr key={order.id}>
                          <td style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-soft)" }}>{order.id.slice(-8)}</td>
                          <td><StatusBadge tone={order.priorityScore >= 75 ? "danger" : "neutral"}>{order.priorityScore.toFixed(0)}</StatusBadge></td>
                          <td style={{ fontWeight: 600, color: "var(--text)" }}>{order.product.sku}</td>
                          <td>{order.quantity}</td>
                          <td>
                            <StageTracker status={order.status} doneOps={doneOps} totalOps={totalOps} />
                          </td>
                          <td>{order.salesOrder ? new Date(order.salesOrder.dueDate).toLocaleDateString() : "—"}</td>
                          <td>{order.salesOrder?.customer.name ?? "—"}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title="🤖 Plan History — Production Planning Agent" subtitle="Only requests where production planning actually ran (MTO/CTO/HYBRID) — MTS/Trading/Third-Party never reach here.">
            <table className="grid">
              <thead>
                <tr><th>Run</th><th>Status</th><th>Started</th><th>Finished</th></tr>
              </thead>
              <tbody>
                {runs.length === 0 ? (
                  <tr><td colSpan={4} style={{ textAlign: "center", color: "var(--text-soft)" }}>No runs recorded yet.</td></tr>
                ) : (
                  runs.map((run) => (
                    <tr key={run.id}>
                      <td style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-soft)" }}>{run.id.slice(-8)}</td>
                      <td><StatusBadge tone={statusTone(run.status)}>{run.status}</StatusBadge></td>
                      <td>{new Date(run.createdAt).toLocaleString()}</td>
                      <td>{run.finishedAt ? new Date(run.finishedAt).toLocaleString() : "—"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </Panel>
        </div>

        <Panel title="Gauges (30d)" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 24 }}>
          <Gauge label="On time" value={deviation?.onTimePct ?? null} goodDirection="up" />
          <Gauge label="Productivity" value={deviation?.productivityPct ?? null} goodDirection="up" />
          <Gauge label="Scrap" value={scrap?.scrapPct ?? null} goodDirection="down" />
        </Panel>
      </div>
    </div>
  );
}
