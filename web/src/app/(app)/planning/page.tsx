import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { listPlantsForEnterprise } from "@/lib/tenant";
import { fetchCapacityRollup, fetchDemandRollup, fetchDeviationRollup } from "@/lib/services";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/States";
import { PlanningRollup } from "@/components/PlanningRollup";

export const metadata: Metadata = { title: "Planning" };

// Real Monthly/Weekly/Daily Planning (Phase 5, agreed with the user) — same
// plant-selector pattern as every other page. Real data only, capped at
// the real ~13-week horizon (HORIZON_WEEKS/PLANNING_HORIZON_DAYS) — no
// forecast/backlog concept invented, no fabricated numbers past what
// capacity/schedule data actually covers.
export default async function PlanningPage({
  searchParams,
}: {
  searchParams: Promise<{ plantId?: string }>;
}) {
  const session = await auth();
  const { plantId: requestedPlantId } = await searchParams;
  const plants = session?.user.enterpriseId
    ? await listPlantsForEnterprise(session.user.enterpriseId)
    : await prisma.plant.findMany({ orderBy: { code: "asc" } });
  const selectedPlant = plants.find((p) => p.id === requestedPlantId) ?? plants[0];

  if (!selectedPlant) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Planning" />
        <EmptyState title="No plants exist yet" />
      </div>
    );
  }

  const [capacityWeeks, demandWeeks, deviationWeeks] = await Promise.all([
    fetchCapacityRollup(selectedPlant.id),
    fetchDemandRollup(selectedPlant.id),
    fetchDeviationRollup(selectedPlant.id),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Planning"
        actions={
          plants.length > 0 ? (
            <form method="get" className="flex items-center gap-2">
              <select
                name="plantId"
                defaultValue={selectedPlant.id}
                className="h-9 rounded-lg border border-border bg-surface px-2 text-sm text-foreground"
              >
                {plants.map((p) => (
                  <option key={p.id} value={p.id}>{p.code}</option>
                ))}
              </select>
              <button type="submit" className="text-sm font-medium text-brand-600 hover:underline">Switch</button>
            </form>
          ) : undefined
        }
      />

      <Card>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Capacity vs Demand vs Plan-vs-Actual</h2>
            <p className="mt-1 text-xs text-muted">
              Practical capacity load (Phase 2), real committed demand by scheduled week, and real on-time/productivity trend — every number derived from real data, nothing forecast or fabricated.
            </p>
          </div>
          <Link href={`/schedule?plantId=${selectedPlant.id}`} className="shrink-0 text-xs font-medium text-brand-600 hover:underline">
            Day-level detail on Schedule →
          </Link>
        </div>
        {capacityWeeks.length === 0 ? (
          <EmptyState title="No capacity data yet" description="Run scheduling for this plant first." />
        ) : (
          <PlanningRollup capacityWeeks={capacityWeeks} demandWeeks={demandWeeks} deviationWeeks={deviationWeeks} />
        )}
      </Card>
    </div>
  );
}
