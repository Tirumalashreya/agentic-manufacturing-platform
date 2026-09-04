import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { listPlantsForEnterprise } from "@/lib/tenant";
import { fetchWorkload } from "@/lib/services";
import { Badge } from "@/components/ui/Badge";

export const metadata: Metadata = { title: "Machines" };

function loadBadgeClass(pct: number) {
  if (pct >= 90) return "border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-900/40 dark:text-red-300";
  if (pct >= 70) return "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
  return "border-green-300 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-900/40 dark:text-green-300";
}

// One row per real machine — rated capacity, batch size, capability count,
// and current load % (the same real number the /schedule Workload graph
// shows, from the capacity engine, not a separate calculation).
export default async function MachinesPage({
  searchParams,
}: {
  searchParams: Promise<{ plantId?: string }>;
}) {
  const session = await auth();
  const { plantId: requestedPlantId } = await searchParams;
  const plants = await listPlantsForEnterprise(session?.user.enterpriseId ?? null);
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
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-foreground">Machines</h1>
        {plants.length > 0 && selectedPlant && (
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
        )}
      </div>

      {!selectedPlant ? (
        <p className="text-sm text-muted">No plants exist yet.</p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-2xl border border-border bg-surface p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">Machines loaded</p>
              <p className="mt-2 text-3xl font-semibold text-foreground">{machines.length}</p>
            </div>
            <div className="rounded-2xl border border-border bg-surface p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">Combined rated capacity</p>
              <p className="mt-2 text-3xl font-semibold text-foreground">{totalCapacity.toFixed(1)}</p>
            </div>
            <div className="rounded-2xl border border-border bg-surface p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">Over 90% load</p>
              <p className="mt-2 text-3xl font-semibold text-foreground">
                {[...loadByMachineId.values()].filter((pct) => pct >= 90).length}
              </p>
            </div>
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
                      <tr key={machine.id}>
                        <td className="px-4 py-3 font-medium text-foreground">{machine.name}</td>
                        <td className="px-4 py-3 text-muted">{machine.workCenter.code}</td>
                        <td className="px-4 py-3 text-muted">{machine.ratedCapacity}</td>
                        <td className="px-4 py-3 text-muted">{machine.minBatch}–{machine.maxBatch ?? "∞"}</td>
                        <td className="px-4 py-3 text-muted">
                          {machine.capabilities.length === 0 ? "—" : `${machine.capabilities.length} operation(s)`}
                        </td>
                        <td className="px-4 py-3 text-muted">{machine.status}</td>
                        <td className="px-4 py-3">
                          {loadPct == null ? (
                            <span className="text-muted">—</span>
                          ) : (
                            <Badge className={loadBadgeClass(loadPct)}>{loadPct.toFixed(1)}%</Badge>
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
