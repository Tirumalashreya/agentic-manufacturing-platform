import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { listPlantsForEnterprise } from "@/lib/tenant";
import { fetchWorkload } from "@/lib/services";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { PageHeader } from "@/components/ui/PageHeader";
import { MetricCard } from "@/components/ui/MetricCard";
import { EmptyState } from "@/components/ui/States";
import { machineStatusTone, loadTone } from "@/lib/statusTone";

export const metadata: Metadata = { title: "Machines" };

// One row per real machine — rated capacity, batch size, capability count,
// and current load % (the same real number the /schedule Workload graph
// shows, from the capacity engine, not a separate calculation).
export default async function MachinesPage({
  searchParams,
}: {
  searchParams: Promise<{ plantId?: string; highlight?: string }>;
}) {
  const session = await auth();
  const { plantId: requestedPlantId, highlight } = await searchParams;
  // Same fallback /schedule and /production-planning already use — no
  // session (this page is public, unauthenticated, per proxy.ts) means
  // no enterpriseId to scope by, so list every real plant directly
  // instead of an enterprise-scoped query that would always return none.
  const plants = session
    ? await listPlantsForEnterprise(session.user.enterpriseId)
    : await prisma.plant.findMany({ orderBy: { code: "asc" } });
  const selectedPlant = plants.find((p) => p.id === requestedPlantId) ?? plants[0];

  const [machines, workload] = selectedPlant
    ? await Promise.all([
        prisma.machine.findMany({
          where: { workCenter: { plantId: selectedPlant.id } },
          include: { workCenter: { select: { code: true } }, capabilities: true },
          orderBy: [{ workCenter: { code: "asc" } }, { name: "asc" }],
        }),
        fetchWorkload(selectedPlant.id),
      ])
    : [[], []];

  const loadByMachineId = new Map(workload.map((w) => [w.machineId, w.loadPct]));
  const totalCapacity = machines.reduce((sum, m) => sum + m.ratedCapacity, 0);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Machines"
        actions={
          plants.length > 0 && selectedPlant ? (
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

      {!selectedPlant ? (
        <EmptyState title="No plants exist yet" />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <MetricCard label="Machines loaded" value={machines.length} />
            <MetricCard label="Combined rated capacity" value={totalCapacity.toFixed(1)} />
            <MetricCard
              label="Over 90% load"
              value={[...loadByMachineId.values()].filter((pct) => pct >= 90).length}
            />
          </div>

          <div className="overflow-x-auto rounded-2xl border border-border">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="bg-surface-muted text-left text-xs font-semibold uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-3">Machine</th>
                  <th className="px-4 py-3">Work center</th>
                  <th className="px-4 py-3">Rated capacity</th>
                  <th className="px-4 py-3">Batch (min–max)</th>
                  <th className="px-4 py-3">Can run</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Load (this week)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {machines.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-6 text-center text-muted">No machines loaded yet.</td>
                  </tr>
                ) : (
                  machines.map((machine) => {
                    const loadPct = loadByMachineId.get(machine.id);
                    return (
                      <tr key={machine.id} className={machine.id === highlight ? "bg-warning-soft" : undefined}>
                        <td className="px-4 py-3 font-medium text-foreground">
                          {machine.name}
                          {machine.id === highlight && (
                            <StatusBadge tone="warning" className="ml-2">Bottleneck</StatusBadge>
                          )}
                        </td>
                        <td className="px-4 py-3 text-muted">{machine.workCenter.code}</td>
                        <td className="px-4 py-3 text-muted">{machine.ratedCapacity}</td>
                        <td className="px-4 py-3 text-muted">{machine.minBatch}–{machine.maxBatch ?? "∞"}</td>
                        <td className="px-4 py-3 text-muted">
                          {machine.capabilities.length === 0 ? "—" : `${machine.capabilities.length} operation(s)`}
                        </td>
                        <td className="px-4 py-3"><StatusBadge tone={machineStatusTone(machine.status)}>{machine.status}</StatusBadge></td>
                        <td className="px-4 py-3">
                          {loadPct == null ? (
                            <span className="text-muted">—</span>
                          ) : (
                            <StatusBadge tone={loadTone(loadPct)}>{loadPct.toFixed(1)}%</StatusBadge>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
