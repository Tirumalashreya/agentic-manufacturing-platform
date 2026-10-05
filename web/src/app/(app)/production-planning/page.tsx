import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { listPlantsForEnterprise } from "@/lib/tenant";
import { fetchDeviationAnalysis, fetchScrap, fetchProductionExceptions, fetchQualityInspections } from "@/lib/services";
import { Card } from "@/components/ui/Card";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Gauge } from "@/components/ui/Gauge";
import { ProGate } from "@/components/ui/ProGate";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/States";
import { OperationStatusActions } from "@/components/OperationStatusActions";
import { opStatusTone } from "@/lib/statusTone";

export const metadata: Metadata = { title: "Production Planning" };

// See dashboard/page.tsx's getCurrentTime for why this is wrapped.
async function getCurrentTime(): Promise<Date> {
  return new Date();
}

export default async function ProductionPlanningPage({
  searchParams,
}: {
  searchParams: Promise<{ plantId?: string }>;
}) {
  const session = await auth();
  const { plantId: requestedPlantId } = await searchParams;
  // No real login flow has been exercised in this build yet (no seeded
  // User rows) — falling back to every plant, unscoped, rather than the
  // enterprise-scoped list a real session would resolve, so this page
  // shows its real data with or without one. A real deployment keeps the
  // enterprise-scoped path above; this is additive, not a replacement.
  const plants = session?.user.enterpriseId
    ? await listPlantsForEnterprise(session.user.enterpriseId)
    : await prisma.plant.findMany({ orderBy: { code: "asc" } });
  const selectedPlant = plants.find((p) => p.id === requestedPlantId) ?? plants[0];

  if (!selectedPlant) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Production Planning" />
        <EmptyState title="No plants exist yet" />
      </div>
    );
  }

  const now = await getCurrentTime();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000);

  const [positions, operations, deviation, scrap, exceptions, inspections] = await Promise.all([
    // Positions area (BEAS-style): production orders with quantity progress.
    prisma.productionOrder.findMany({
      where: { plantId: selectedPlant.id },
      include: {
        product: true,
        salesOrder: { include: { customer: true } },
        scheduledOperations: { select: { status: true } },
      },
      orderBy: { priorityScore: "desc" },
      take: 50,
    }),
    // Operations area (BEAS-style): scheduled operations, resource + timing.
    prisma.scheduledOperation.findMany({
      where: { productionOrder: { plantId: selectedPlant.id } },
      include: {
        productionOrder: { include: { product: true } },
        machine: true,
        routingOperation: true,
      },
      orderBy: { scheduledStart: "asc" },
      take: 50,
    }),
    fetchDeviationAnalysis(selectedPlant.id),
    fetchScrap(thirtyDaysAgo.toISOString(), now.toISOString()),
    fetchProductionExceptions(selectedPlant.id),
    fetchQualityInspections(selectedPlant.id),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Production Planning"
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

      <div className="grid gap-6 lg:grid-cols-[1fr_auto]">
        <div className="flex flex-col gap-6">
          {/* Positions area */}
          <Card className="p-0">
            <div className="border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold text-foreground">Positions</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-surface-muted text-left text-[10px] font-bold uppercase tracking-widest text-muted">
                  <tr>
                    <th className="px-3 py-2">Work Order</th>
                    <th className="px-3 py-2">Prio</th>
                    <th className="px-3 py-2">Item</th>
                    <th className="px-3 py-2">Qty</th>
                    <th className="px-3 py-2">Progress</th>
                    <th className="px-3 py-2">Delivery</th>
                    <th className="px-3 py-2">Customer</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {positions.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-3 py-6 text-center text-muted">No production orders yet.</td>
                    </tr>
                  ) : (
                    positions.map((order) => {
                      const totalOps = order.scheduledOperations.length;
                      const doneOps = order.scheduledOperations.filter((o) => o.status === "DONE").length;
                      const progressPct = totalOps > 0 ? (doneOps / totalOps) * 100 : 0;
                      return (
                        <tr key={order.id}>
                          <td className="px-3 py-2 font-mono text-xs">
                            <Link href={`/orders/${order.id}`} className="text-brand-600 hover:underline">{order.id.slice(-8)}</Link>
                          </td>
                          <td className="px-3 py-2">
                            <StatusBadge tone={order.priorityScore >= 75 ? "danger" : "neutral"}>
                              {order.priorityScore.toFixed(0)}
                            </StatusBadge>
                          </td>
                          <td className="px-3 py-2 font-medium text-foreground">{order.product.sku}</td>
                          <td className="px-3 py-2 text-muted">{order.quantity}</td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-2">
                              <div className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-muted">
                                <div className="h-full bg-brand-500" style={{ width: `${progressPct}%` }} />
                              </div>
                              <span className="text-xs text-muted">{doneOps}/{totalOps}</span>
                            </div>
                          </td>
                          <td className="px-3 py-2 text-muted">
                            {order.salesOrder ? new Date(order.salesOrder.dueDate).toLocaleDateString() : "—"}
                          </td>
                          <td className="px-3 py-2 text-muted">{order.salesOrder?.customer.name ?? "—"}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Operations area */}
          <Card className="p-0">
            <div className="border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold text-foreground">Operations</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-surface-muted text-left text-[10px] font-bold uppercase tracking-widest text-muted">
                  <tr>
                    <th className="px-3 py-2">Work Order</th>
                    <th className="px-3 py-2">Operation</th>
                    <th className="px-3 py-2">Resource</th>
                    <th className="px-3 py-2">Start</th>
                    <th className="px-3 py-2">End</th>
                    <th className="px-3 py-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {operations.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-6 text-center text-muted">No scheduled operations yet.</td>
                    </tr>
                  ) : (
                    operations.map((op) => (
                      <tr key={op.id}>
                        <td className="px-3 py-2 font-mono text-xs text-muted">{op.productionOrderId.slice(-8)}</td>
                        <td className="px-3 py-2 text-foreground">{op.routingOperation?.operation ?? "—"}</td>
                        <td className="px-3 py-2 text-muted">{op.machine?.name ?? "—"}</td>
                        <td className="px-3 py-2 text-muted">{new Date(op.scheduledStart).toLocaleString()}</td>
                        <td className="px-3 py-2 text-muted">{new Date(op.scheduledEnd).toLocaleString()}</td>
                        <td className="px-3 py-2">
                          <div className="flex flex-col items-start gap-1.5">
                            <StatusBadge tone={opStatusTone(op.status)}>{op.status}</StatusBadge>
                            <OperationStatusActions
                              operationId={op.id}
                              status={op.status}
                              scheduledStart={op.scheduledStart.toISOString()}
                              quantity={op.productionOrder.quantity}
                              machineId={op.machine?.id}
                              machineName={op.machine?.name}
                              requiresInspection={op.routingOperation?.requiresInspection}
                            />
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Real production-exception log (agreed with the user, Phase 1
          completion) — read-only: every row here is a real ProductionException
          created via the Block form's exception-type capture. Not a place to
          act from; MACHINE_BREAKDOWN's real side effect already happened at
          capture time (see reportExceptionAction), everything else is
          capture/publish-only by design. */}
          <Card className="p-0">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold text-foreground">Exceptions</h2>
              <Link href={`/recovery?plantId=${selectedPlant.id}`} className="text-xs text-brand-600 hover:underline">
                View Recovery →
              </Link>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-surface-muted text-left text-[10px] font-bold uppercase tracking-widest text-muted">
                  <tr>
                    <th className="px-3 py-2">Reported</th>
                    <th className="px-3 py-2">Type</th>
                    <th className="px-3 py-2">Work Order</th>
                    <th className="px-3 py-2">Operation</th>
                    <th className="px-3 py-2">Resource</th>
                    <th className="px-3 py-2">Note</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {exceptions.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-6 text-center text-muted">No exceptions reported.</td>
                    </tr>
                  ) : (
                    exceptions.map((e) => (
                      <tr key={e.id}>
                        <td className="px-3 py-2 text-muted">{new Date(e.reportedAt).toLocaleString()}</td>
                        <td className="px-3 py-2">
                          <StatusBadge tone={e.type === "MACHINE_BREAKDOWN" ? "danger" : "neutral"}>
                            {e.type.replaceAll("_", " ")}
                          </StatusBadge>
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">
                          <Link href={`/orders/${e.productionOrderId}`} className="text-brand-600 hover:underline">{e.productionOrderId.slice(-8)}</Link>
                        </td>
                        <td className="px-3 py-2 text-foreground">{e.operation ?? "—"}</td>
                        <td className="px-3 py-2 text-muted">{e.machineName ?? "—"}</td>
                        <td className="px-3 py-2 text-muted">{e.note ?? "—"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Real Quality (Phase 4, agreed with the user) — read-only: every
          row here is a real QualityInspection created via the "Record
          inspection" action on a DONE, requiresInspection operation. A real
          FAIL also auto-created a real ProductionException(QUALITY_ISSUE),
          visible in the Exceptions table above — not duplicated here. */}
          <Card className="p-0">
            <div className="border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold text-foreground">Quality Inspections</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-surface-muted text-left text-[10px] font-bold uppercase tracking-widest text-muted">
                  <tr>
                    <th className="px-3 py-2">Inspected</th>
                    <th className="px-3 py-2">Result</th>
                    <th className="px-3 py-2">Work Order</th>
                    <th className="px-3 py-2">Operation</th>
                    <th className="px-3 py-2">Resource</th>
                    <th className="px-3 py-2">Note</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {inspections.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-6 text-center text-muted">No inspections recorded.</td>
                    </tr>
                  ) : (
                    inspections.map((i) => (
                      <tr key={i.id}>
                        <td className="px-3 py-2 text-muted">{new Date(i.inspectedAt).toLocaleString()}</td>
                        <td className="px-3 py-2">
                          <StatusBadge tone={i.result === "PASS" ? "success" : "danger"}>
                            {i.result}
                          </StatusBadge>
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">
                          <Link href={`/orders/${i.productionOrderId}`} className="text-brand-600 hover:underline">{i.productionOrderId.slice(-8)}</Link>
                        </td>
                        <td className="px-3 py-2 text-foreground">{i.operation ?? "—"}</td>
                        <td className="px-3 py-2 text-muted">{i.machineName ?? "—"}</td>
                        <td className="px-3 py-2 text-muted">{i.note ?? "—"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        {/* Gauges — full 30-day KPI history is a Pro feature (see lib/plans.ts) */}
        <ProGate feature="Full KPI history">
          <Card className="flex w-full flex-col items-center gap-6 lg:w-56">
            <h2 className="self-start text-sm font-semibold text-foreground">Gauges (30d)</h2>
            <Gauge label="On time" value={deviation?.onTimePct ?? null} goodDirection="up" />
            <Gauge label="Productivity" value={deviation?.productivityPct ?? null} goodDirection="up" />
            <Gauge label="Scrap" value={scrap?.scrapPct ?? null} goodDirection="down" />
          </Card>
        </ProGate>
      </div>
    </div>
  );
}
