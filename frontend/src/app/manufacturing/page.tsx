import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { PageHeader, Panel, MetricCard, MetricGrid, EmptyState } from "@/components/ui";

export const metadata: Metadata = { title: "Manufacturing" };

// Manufacturing's own landing page — deliberately separate from the Sales
// "Command centre" at "/". Sales and Production Planning are different
// departments in any real company; sharing one dashboard/nav made that
// distinction invisible. Only Plan lives here — a real Schedule/APS Status
// view now lives per-order inside /domestic-sales/[id] instead, and the
// Schedule/Execute links that used to point out to APS Platform were
// removed (agreed with the user): they were a leftover doorway from
// before that per-order page existed, and "Execute" specifically let a
// Sales user click straight onto the operator-only app from their own
// nav. Operators reach APS Platform directly now, not through Ledger.
const STAGE_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  PLANNED: "Planned",
  RELEASED: "Released",
  IN_PROGRESS: "In Production",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

export default async function ManufacturingPage({
  searchParams,
}: {
  searchParams: Promise<{ plantId?: string }>;
}) {
  const { plantId: requestedPlantId } = await searchParams;
  const plants = await prisma.plant.findMany({ orderBy: { code: "asc" } });
  const selectedPlant = plants.find((p) => p.id === requestedPlantId) ?? plants[0];

  if (!selectedPlant) {
    return (
      <div>
        <PageHeader kicker="PLANT OPERATIONS" title="Manufacturing" />
        <EmptyState title="No plants exist yet" description="Run the seed script first." />
      </div>
    );
  }

  const byStatus = await prisma.productionOrder.groupBy({
    by: ["status"],
    where: { plantId: selectedPlant.id },
    _count: { _all: true },
  });

  const countFor = (status: string) => byStatus.find((r) => r.status === status)?._count._all ?? 0;
  const stageOrder = ["DRAFT", "PLANNED", "RELEASED", "IN_PROGRESS", "COMPLETED", "CANCELLED"];

  return (
    <div>
      <PageHeader
        kicker="PLANT OPERATIONS"
        title="Manufacturing"
        description={`${selectedPlant.code} · three separate jobs, not one screen — what to build, when and on what, and what the floor is actually doing right now.`}
      />

      <MetricGrid>
        {stageOrder.map((status) => (
          <MetricCard key={status} label={STAGE_LABELS[status]} value={countFor(status)} note="Production orders" />
        ))}
      </MetricGrid>

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "minmax(0, 360px)", marginTop: 20 }}>
        <Link href="/production-planning" style={{ display: "block", textDecoration: "none" }}>
          <Panel title="Plan">
            <p className="panel-sub" style={{ marginBottom: 0 }}>
              Materials, routing, verdict — every pre-commit decision, plus the AI&apos;s Plan History. Nothing here is irreversible yet.
              For a specific order&apos;s real Schedule and APS Status, open it from Domestic Sales.
            </p>
          </Panel>
        </Link>
      </div>
    </div>
  );
}
