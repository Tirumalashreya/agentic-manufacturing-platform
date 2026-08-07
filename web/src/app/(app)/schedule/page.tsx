import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { listPlantsForEnterprise } from "@/lib/tenant";
import { MachineGanttChart } from "@/components/MachineGanttChart";
import { RunSchedulingButton } from "@/components/RunSchedulingButton";
import { LeadTimePreview } from "@/components/LeadTimePreview";
import { WorkloadGraph } from "@/components/WorkloadGraph";
import { WhatIfPanel } from "@/components/WhatIfPanel";
import { DisruptionSimulator } from "@/components/DisruptionSimulator";
import { Card } from "@/components/ui/Card";
import { fetchWorkload, fetchDemoTickerStatus } from "@/lib/services";
import { computeLatenessStatus } from "@/lib/lateness";

export const metadata: Metadata = { title: "Schedule" };

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ plantId?: string }>;
}) {
  const session = await auth();
  const { plantId: requestedPlantId } = await searchParams;
  const plants = await listPlantsForEnterprise(session?.user.enterpriseId ?? null);
  const selectedPlant = plants.find((p) => p.id === requestedPlantId) ?? plants[0];

  const machines = selectedPlant
    ? await prisma.machine.findMany({
        where: { workCenter: { plantId: selectedPlant.id } },
        include: {
          workCenter: { select: { code: true } },
          scheduledOperations: {
            where: { status: { in: ["SCHEDULED", "IN_PROGRESS", "BLOCKED"] } },
            include: {
              productionOrder: { include: { product: true, salesOrder: { select: { dueDate: true } } } },
              routingOperation: { select: { operation: true } },
              operator: { select: { name: true } },
            },
          },
        },
        orderBy: { name: "asc" },
      })
    : [];

  function toOp(op: (typeof machines)[number]["scheduledOperations"][number], machineName: string | null) {
    const dueDate = op.productionOrder.salesOrder?.dueDate ?? null;
    return {
      id: op.id,
      scheduledStart: op.scheduledStart,
      scheduledEnd: op.scheduledEnd,
      productSku: op.productionOrder.product.sku,
      status: op.status,
      productionOrderId: op.productionOrderId,
      quantity: op.productionOrder.quantity,
      operationName: op.routingOperation?.operation ?? null,
      dueDate,
      latenessStatus: computeLatenessStatus(op.scheduledEnd, dueDate, op.actualEnd),
      metadata: op.productionOrder.metadata as Record<string, unknown> | null,
      machineName,
      operatorName: op.operator?.name ?? null,
    };
  }

  const machineRows = machines.map((m) => ({
    resourceId: m.id,
    resourceName: m.name,
    resourceSubtitle: m.workCenter.code,
    ops: m.scheduledOperations.map((op) => toOp(op, m.name)),
  }));

  // Proficy-style operator rows — only operators with ≥1 real assigned
  // operation appear (see pipeline.ts's guarded operator resolution: a plant
  // with no operators configured never populates operatorId, so this stays
  // empty and the chart looks exactly as it did before operator scheduling
  // existed).
  const operatorOpsById = new Map<string, { name: string; ops: ReturnType<typeof toOp>[] }>();
  for (const m of machines) {
    for (const op of m.scheduledOperations) {
      if (!op.operator) continue;
      const entry = operatorOpsById.get(op.operatorId!) ?? { name: op.operator.name, ops: [] };
      entry.ops.push(toOp(op, m.name));
      operatorOpsById.set(op.operatorId!, entry);
    }
  }
  const operatorRows = [...operatorOpsById.entries()].map(([operatorId, { name, ops }]) => ({
    resourceId: operatorId,
    resourceName: name,
    ops,
  }));

  const totalOps = machineRows.reduce((sum, r) => sum + r.ops.length, 0);
  const workload = selectedPlant ? await fetchWorkload(selectedPlant.id) : [];
  const workCenters = selectedPlant
    ? await prisma.workCenter.findMany({ where: { plantId: selectedPlant.id }, select: { id: true, code: true }, orderBy: { code: "asc" } })
    : [];

  const disruptionMachines = machines.map((m) => ({ id: m.id, name: m.name, status: m.status }));
  const disruptionOrders = selectedPlant
    ? (
        await prisma.productionOrder.findMany({
          where: { plantId: selectedPlant.id, status: { notIn: ["COMPLETED", "CANCELLED"] } },
          include: { product: { select: { sku: true } } },
          orderBy: { createdAt: "desc" },
        })
      ).map((o) => ({ id: o.id, productSku: o.product.sku, quantity: o.quantity, status: o.status }))
    : [];
  const tickerStatus = await fetchDemoTickerStatus();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-foreground">Schedule</h1>
        {selectedPlant && <RunSchedulingButton plantId={selectedPlant.id} />}
      </div>

      {!selectedPlant ? (
        <p className="text-sm text-muted">No plants exist yet.</p>
      ) : (
        <>
          <LeadTimePreview plantId={selectedPlant.id} />
          <DisruptionSimulator
            machines={disruptionMachines}
            orders={disruptionOrders}
            initialTickerEnabled={tickerStatus.enabled}
          />
          <WhatIfPanel plantId={selectedPlant.id} workCenters={workCenters} />
          {totalOps === 0 ? (
            <div className="rounded-2xl border border-border bg-surface p-10 text-center text-sm text-muted">
              No scheduled operations yet — create a production order and run the scheduling pipeline.
            </div>
          ) : (
            <MachineGanttChart machineRows={machineRows} operatorRows={operatorRows} />
          )}

          <Card>
            <h2 className="text-sm font-semibold text-foreground">Workload (this week)</h2>
            <p className="mt-1 text-xs text-muted">
              Real load % per machine from the capacity engine — over 90% (red) is overloaded.
            </p>
            <div className="mt-4">
              <WorkloadGraph machines={workload} />
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
