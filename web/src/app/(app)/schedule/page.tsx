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
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/States";
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
  // See production-planning/page.tsx's identical fallback for why.
  const plants = session?.user.enterpriseId
    ? await listPlantsForEnterprise(session.user.enterpriseId)
    : await prisma.plant.findMany({ orderBy: { code: "asc" } });
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
              routingOperation: { select: { operation: true, requiresInspection: true } },
              operator: { select: { name: true } },
            },
          },
        },
        orderBy: { name: "asc" },
      })
    : [];

  function toOp(op: (typeof machines)[number]["scheduledOperations"][number], machineId: string, machineName: string | null) {
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
      machineId,
      machineName,
      operatorName: op.operator?.name ?? null,
      requiresInspection: op.routingOperation?.requiresInspection,
    };
  }

  const machineRows = machines.map((m) => ({
    resourceId: m.id,
    resourceName: m.name,
    resourceSubtitle: m.workCenter.code,
    ops: m.scheduledOperations.map((op) => toOp(op, m.id, m.name)),
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
      entry.ops.push(toOp(op, m.id, m.name));
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
      <PageHeader title="Schedule" actions={selectedPlant ? <RunSchedulingButton plantId={selectedPlant.id} /> : undefined} />

      {!selectedPlant ? (
        <EmptyState title="No plants exist yet" />
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
            <Card>
              <EmptyState
                title="No scheduled operations yet"
                description="Create a production order and run the scheduling pipeline."
              />
            </Card>
          ) : (
            <MachineGanttChart machineRows={machineRows} operatorRows={operatorRows} />
          )}

          <Card>
            <h2 className="text-sm font-semibold text-foreground">Workload (this week)</h2>
            <p className="mt-1 text-xs text-muted">
              Real used minutes over practical capacity (shift/holiday/break/maintenance/efficiency-adjusted) per machine —
              over 90% (red) is overloaded. Raw % (of the full 24/7 week) shown below each bar for comparison.
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
