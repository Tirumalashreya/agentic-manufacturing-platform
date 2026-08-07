import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { listPlantsForEnterprise } from "@/lib/tenant";
import { fetchDeviationAnalysis, fetchScrap } from "@/lib/services";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Gauge } from "@/components/ui/Gauge";
import { ProGate } from "@/components/ui/ProGate";
import { OperationStatusActions } from "@/components/OperationStatusActions";

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
  const plants = await listPlantsForEnterprise(session?.user.enterpriseId ?? null);
  const selectedPlant = plants.find((p) => p.id === requestedPlantId) ?? plants[0];

  if (!selectedPlant) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-semibold text-foreground">Production Planning</h1>
        <p className="text-sm text-muted">No plants exist yet.</p>
      </div>
    );
  }

  const now = await getCurrentTime();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000);

  const [positions, operations, deviation, scrap] = await Promise.all([
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
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-foreground">Production Planning</h1>
        {plants.length > 0 && (
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
                          <td className="px-3 py-2 font-mono text-xs text-muted">{order.id.slice(-8)}</td>
                          <td className="px-3 py-2">
                            <Badge className={order.priorityScore >= 75 ? "border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-900/40 dark:text-red-300" : undefined}>
                              {order.priorityScore.toFixed(0)}
                            </Badge>
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
                            <Badge>{op.status}</Badge>
                            <OperationStatusActions
                              operationId={op.id}
                              status={op.status}
                              scheduledStart={op.scheduledStart.toISOString()}
                              quantity={op.productionOrder.quantity}
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
