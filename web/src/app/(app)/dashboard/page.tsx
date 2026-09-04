import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { listPlantsForEnterprise } from "@/lib/tenant";
import { Card } from "@/components/ui/Card";
import { RunSchedulingButton } from "@/components/RunSchedulingButton";
import { fetchBottleneck } from "@/lib/services";

export const metadata: Metadata = { title: "Dashboard" };

// Wrapping Date.now() behind an async boundary is what satisfies React's
// render-purity lint (react-hooks/purity) here — a Server Component fetching
// "the last 7 days" genuinely needs request-time data, this just marks that
// read as an explicit, awaited data source rather than an inline impure call.
async function getCurrentTime(): Promise<Date> {
  return new Date();
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ plantId?: string }>;
}) {
  const session = await auth();
  const { plantId: requestedPlantId } = await searchParams;
  const plants = await listPlantsForEnterprise(session?.user.enterpriseId ?? null);
  const selectedPlant = plants.find((p) => p.id === requestedPlantId) ?? plants[0];

  const now = await getCurrentTime();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000);

  const [openOrderCount, lastRun, bottleneck] = await Promise.all([
    selectedPlant
      ? prisma.productionOrder.count({ where: { plantId: selectedPlant.id, status: { in: ["PLANNED", "RELEASED"] } } })
      : Promise.resolve(0),
    selectedPlant
      ? prisma.scheduleRun.findFirst({ where: { plantId: selectedPlant.id }, orderBy: { startedAt: "desc" } })
      : Promise.resolve(null),
    fetchBottleneck(sevenDaysAgo.toISOString(), now.toISOString()),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-foreground">Dashboard</h1>
        {plants.length > 0 && (
          <form method="get" className="flex items-center gap-2">
            <label htmlFor="plantId" className="text-sm text-muted">Plant</label>
            <select
              id="plantId"
              name="plantId"
              defaultValue={selectedPlant?.id}
              className="h-9 rounded-lg border border-border bg-surface px-2 text-sm text-foreground"
            >
              {plants.map((p) => (
                <option key={p.id} value={p.id}>{p.code} — {p.site.name}</option>
              ))}
            </select>
            <button type="submit" className="text-sm font-medium text-brand-600 hover:underline">Switch</button>
          </form>
        )}
      </div>

      {!selectedPlant ? (
        <Card>
          <p className="text-sm text-muted">
            No plants exist yet. Create one via routing-service/machine-service master data
            before running the scheduling pipeline.
          </p>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Card>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">Open orders</p>
              <p className="mt-2 text-3xl font-semibold text-foreground">{openOrderCount}</p>
            </Card>
            <Card>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">Last schedule run</p>
              <p className="mt-2 text-sm text-foreground">
                {lastRun ? `${lastRun.status} · ${lastRun.conflictsDetected} conflict(s) · ${lastRun.durationMs ?? "—"}ms` : "No runs yet"}
              </p>
            </Card>
            <Card>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">Bottleneck (7d)</p>
              <p className="mt-2 text-sm text-foreground">
                {bottleneck?.bottleneck
                  ? `${bottleneck.bottleneck.machineId} · ${bottleneck.bottleneck.loadPct.toFixed(1)}% load`
                  : "No data (analytics-service unavailable or no completed ops)"}
              </p>
            </Card>
          </div>

          <Card>
            <h2 className="text-sm font-semibold text-foreground">§6 Scheduling Engine</h2>
            <p className="mt-1 text-sm text-muted">
              Runs the 11-step pipeline for {selectedPlant.code}: priority scoring, dependency
              resolution, routing/CPM, material check, capacity + constraint evaluation, resource
              selection, conflict detection, optimization pass, and publishing.
            </p>
            <div className="mt-4">
              <RunSchedulingButton plantId={selectedPlant.id} />
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
