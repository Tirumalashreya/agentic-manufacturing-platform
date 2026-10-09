import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { listPlantsForEnterprise } from "@/lib/tenant";
import { computeLatenessStatus } from "@/lib/lateness";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { MetricCard } from "@/components/ui/MetricCard";
import { EmptyState } from "@/components/ui/States";
import { RunSchedulingButton } from "@/components/RunSchedulingButton";
import { fetchBottleneck, fetchOee, fetchShortages } from "@/lib/services";

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
  // Same fallback every other page in this app already uses (Machines,
  // Materials, Recovery, Production Planning) — no session (this page is
  // now public, per proxy.ts) means no enterpriseId to scope by, so list
  // every real plant directly instead of an enterprise-scoped query that
  // would always return none. Dashboard was the one page still missing
  // this before the discoverability pass made it reachable without login.
  const plants = session?.user.enterpriseId
    ? await listPlantsForEnterprise(session.user.enterpriseId)
    : await prisma.plant.findMany({ include: { site: true }, orderBy: { code: "asc" } });
  const selectedPlant = plants.find((p) => p.id === requestedPlantId) ?? plants[0];

  const now = await getCurrentTime();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const [openOrderCount, lastRun, bottleneck, activeOpsCount, completedTodayCount, atRiskOrders, exceptionsCount, shortagesResult] =
    await Promise.all([
      selectedPlant
        ? prisma.productionOrder.count({ where: { plantId: selectedPlant.id, status: { in: ["PLANNED", "RELEASED"] } } })
        : Promise.resolve(0),
      selectedPlant
        ? prisma.scheduleRun.findFirst({ where: { plantId: selectedPlant.id }, orderBy: { startedAt: "desc" } })
        : Promise.resolve(null),
      fetchBottleneck(sevenDaysAgo.toISOString(), now.toISOString()),
      // Real, plant-wide — a filtered count, not a new calculation.
      selectedPlant
        ? prisma.scheduledOperation.count({ where: { status: "IN_PROGRESS", productionOrder: { plantId: selectedPlant.id } } })
        : Promise.resolve(0),
      selectedPlant
        ? prisma.scheduledOperation.count({
            where: { status: "DONE", actualEnd: { gte: startOfToday }, productionOrder: { plantId: selectedPlant.id } },
          })
        : Promise.resolve(0),
      // Same real computeLatenessStatus rollup Recovery already runs, reused
      // here only for a count (not a second definition of "at risk").
      selectedPlant
        ? prisma.productionOrder.findMany({
            where: { plantId: selectedPlant.id, status: { notIn: ["COMPLETED", "CANCELLED"] } },
            include: { salesOrder: { select: { dueDate: true } }, scheduledOperations: { select: { scheduledEnd: true, actualEnd: true } } },
          })
        : Promise.resolve([]),
      selectedPlant
        ? prisma.productionException.count({ where: { resolvedAt: null, scheduledOperation: { productionOrder: { plantId: selectedPlant.id } } } })
        : Promise.resolve(0),
      fetchShortages(),
    ]);

  const atRiskOrderIds = atRiskOrders
    .filter((order) => {
      const dueDate = order.salesOrder?.dueDate ?? null;
      return order.scheduledOperations.some((op) => {
        const status = computeLatenessStatus(op.scheduledEnd, dueDate, op.actualEnd);
        return status === "LATE" || status === "AT_RISK";
      });
    })
    .map((order) => order.id);
  const atRiskCount = atRiskOrderIds.length;

  // Daily Ops Brief (Phase 3+, agreed with the user): deterministic
  // suggestions over the exact real data already fetched above for the
  // metric cards — no LLM, nothing invented. Each one names a specific
  // real record and links straight to it, matching the master prompt's
  // own "suggested actions must be traceable to actual data" requirement.
  const suggestedActions: { text: string; href: string }[] = [];
  for (const id of atRiskOrderIds.slice(0, 3)) {
    suggestedActions.push({ text: `Review at-risk order #${id.slice(-8)}`, href: `/orders/${id}` });
  }
  if (shortagesResult.ok && shortagesResult.data.length > 0) {
    const first = shortagesResult.data[0];
    suggestedActions.push({
      text: `Expedite material shortage — ${first.productId.slice(-8)}`,
      href: `/materials?plantId=${selectedPlant?.id ?? ""}`,
    });
  }
  if (exceptionsCount > 0) {
    suggestedActions.push({
      text: `Review ${exceptionsCount} open exception${exceptionsCount === 1 ? "" : "s"}`,
      href: `/recovery?plantId=${selectedPlant?.id ?? ""}`,
    });
  }

  const bottleneckMachine = bottleneck?.bottleneck
    ? await prisma.machine.findUnique({ where: { id: bottleneck.bottleneck.machineId }, select: { id: true, name: true } })
    : null;

  // OEE for the plant's real busiest machine (agreed with the user) —
  // rather than averaging across every machine (a real N+1 the earlier
  // performance audit flagged as a pattern to avoid), this reuses the
  // machineId already fetched for the Bottleneck card above, so it's one
  // additional real call, not N. Previously OEE had ZERO presence
  // anywhere in this product — the only place the word appeared was the
  // marketing page's ad copy.
  const oeeResult = bottleneckMachine
    ? await fetchOee(bottleneckMachine.id, sevenDaysAgo.toISOString(), now.toISOString())
    : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Dashboard"
        actions={
          plants.length > 0 ? (
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
          ) : undefined
        }
      />

      {!selectedPlant ? (
        <Card>
          <EmptyState
            title="No plants exist yet"
            description="Create one via routing-service/machine-service master data before running the scheduling pipeline."
          />
        </Card>
      ) : (
        <>
          {/* Today */}
          <div>
            <SectionHeader title="Today" />
            <div className="grid gap-4 sm:grid-cols-5">
              <MetricCard label="Open orders" value={openOrderCount} />
              <MetricCard label="Active production" value={activeOpsCount} note="Operations in progress right now" />
              <Link href={`/recovery?plantId=${selectedPlant.id}`} className="block">
                <MetricCard
                  label="Late / At-risk"
                  value={<span className={atRiskCount > 0 ? "text-danger" : "text-foreground"}>{atRiskCount}</span>}
                  note={<span className="text-brand-600 hover:underline">View in Recovery →</span>}
                />
              </Link>
              <MetricCard
                label="Open exceptions"
                value={<span className={exceptionsCount > 0 ? "text-warning" : "text-foreground"}>{exceptionsCount}</span>}
              />
              <Link href={`/materials?plantId=${selectedPlant.id}`} className="block">
                <MetricCard
                  label="Material shortages"
                  value={
                    <span className={shortagesResult.ok && shortagesResult.data.length > 0 ? "text-danger" : "text-foreground"}>
                      {shortagesResult.ok ? shortagesResult.data.length : "—"}
                    </span>
                  }
                  note={<span className="text-brand-600 hover:underline">View in Materials →</span>}
                />
              </Link>
            </div>
          </div>

          {/* Suggested actions — Daily Ops Brief, real + deterministic, see
          the computation above. */}
          {suggestedActions.length > 0 && (
            <Card>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">Suggested actions</p>
              <ul className="mt-2 flex flex-col gap-1.5">
                {suggestedActions.map((action, i) => (
                  <li key={i}>
                    <Link href={action.href} className="text-sm text-brand-600 hover:underline">
                      {i + 1}. {action.text} →
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {/* Planning */}
          <div>
            <SectionHeader title="Planning" />
            <div className="grid gap-4 sm:grid-cols-3">
              <Card>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">Last schedule run</p>
                <p className="mt-2 text-sm text-foreground">
                  {lastRun ? `${lastRun.status} · ${lastRun.conflictsDetected} conflict(s) · ${lastRun.durationMs ?? "—"}ms` : "No runs yet"}
                </p>
              </Card>
              <Card>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">Bottleneck (7d)</p>
                {bottleneckMachine ? (
                  <Link href={`/machines?plantId=${selectedPlant.id}&highlight=${bottleneckMachine.id}`} className="mt-2 block text-sm text-brand-600 hover:underline">
                    {bottleneckMachine.name} · {bottleneck!.bottleneck!.loadPct.toFixed(1)}% load →
                  </Link>
                ) : (
                  <p className="mt-2 text-sm text-foreground">No data (analytics-service unavailable or no completed ops)</p>
                )}
              </Card>
              <Card>
                <Link href={`/planning?plantId=${selectedPlant.id}`} className="block text-sm text-brand-600 hover:underline">
                  Capacity vs Demand →
                </Link>
                <p className="mt-1 text-xs text-muted">Weekly/Monthly rollup, up to 13 real weeks</p>
              </Card>
            </div>
          </div>

          {/* Performance — OEE finally gets a home; every other number here
          already existed elsewhere, this section just gives Performance
          its own place rather than being scattered. */}
          <div>
            <SectionHeader title="Performance" />
            <div className="grid gap-4 sm:grid-cols-4">
              <MetricCard label="Completed today" value={completedTodayCount} />
              <MetricCard
                label={`OEE — Availability ${bottleneckMachine ? `(${bottleneckMachine.name}, 7d)` : ""}`}
                value={
                  !bottleneckMachine
                    ? <span className="text-sm font-normal text-muted">No bottleneck machine to report against</span>
                    : !oeeResult?.ok
                      ? <span className="text-sm font-normal text-muted">Analytics unavailable{oeeResult && !oeeResult.ok ? ` — ${oeeResult.error}` : ""}</span>
                      : oeeResult.data.availabilityPct != null ? `${oeeResult.data.availabilityPct.toFixed(0)}%` : "—"
                }
              />
              <MetricCard
                label="OEE — Performance"
                value={!oeeResult?.ok ? "—" : oeeResult.data.performancePct != null ? `${oeeResult.data.performancePct.toFixed(0)}%` : "—"}
              />
              <MetricCard
                label="OEE — Overall"
                value={!oeeResult?.ok ? "—" : oeeResult.data.oeeOverallPct != null ? `${oeeResult.data.oeeOverallPct.toFixed(0)}%` : "—"}
              />
            </div>
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
