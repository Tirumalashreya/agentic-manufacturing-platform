import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { OperatorPicker } from "@/components/OperatorPicker";
import { OperationStatusActions } from "@/components/OperationStatusActions";
import { JobsActionsProvider } from "@/components/JobsActionsProvider";
import { computeLatenessStatus } from "@/lib/lateness";
import { opStatusTone } from "@/lib/statusTone";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { EmptyState } from "@/components/ui/States";
import { Card } from "@/components/ui/Card";

export const metadata: Metadata = { title: "My Jobs" };

// Fulcrum-style Job Tracker, bounded per the plan: an operator's queue of
// assigned operations with working Start/Complete/Block actions, without
// rebuilding a full drag-and-drop planning board (a separate, much larger
// feature — no operator-terminal infrastructure exists to justify it yet).
export default async function MyJobsPage({
  searchParams,
}: {
  searchParams: Promise<{ operatorId?: string }>;
}) {
  const { operatorId } = await searchParams;

  const operators = await prisma.operator.findMany({ orderBy: { name: "asc" } });
  const selectedOperator = operators.find((op) => op.id === operatorId);

  const ops = selectedOperator
    ? await prisma.scheduledOperation.findMany({
        where: { operatorId: selectedOperator.id, status: { in: ["SCHEDULED", "IN_PROGRESS", "BLOCKED"] } },
        include: {
          productionOrder: { include: { product: true, salesOrder: { select: { dueDate: true } } } },
          routingOperation: { select: { operation: true, requiresInspection: true } },
          machine: { select: { name: true } },
        },
        orderBy: { scheduledStart: "asc" },
      })
    : [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="My Jobs" actions={<OperatorPicker operators={operators} selectedOperatorId={selectedOperator?.id} />} />

      {!selectedOperator ? (
        <Card><EmptyState title="Select an operator" description="Pick an operator above to see their assigned jobs." /></Card>
      ) : ops.length === 0 ? (
        <Card><EmptyState title="No jobs assigned" description={`Nothing currently assigned to ${selectedOperator.name}.`} /></Card>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-surface-muted text-left text-xs font-semibold uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3">Operation</th>
                <th className="px-4 py-3">Machine</th>
                <th className="px-4 py-3">Scheduled</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <JobsActionsProvider>
            <tbody className="divide-y divide-border">
              {ops.map((op) => {
                const dueDate = op.productionOrder.salesOrder?.dueDate ?? null;
                const latenessStatus = computeLatenessStatus(op.scheduledEnd, dueDate, op.actualEnd);
                return (
                  <tr key={op.id}>
                    <td className="px-4 py-3 font-medium text-foreground">{op.productionOrder.product.sku}</td>
                    <td className="px-4 py-3 text-muted">{op.routingOperation?.operation ?? "—"}</td>
                    <td className="px-4 py-3 text-muted">{op.machine?.name ?? "—"}</td>
                    <td className="px-4 py-3 text-muted">
                      {op.scheduledStart.toLocaleString()} – {op.scheduledEnd.toLocaleString()}
                      {latenessStatus === "LATE" && <span className="ml-2 text-danger">Late</span>}
                      {latenessStatus === "AT_RISK" && <span className="ml-2 text-warning">At risk</span>}
                    </td>
                    <td className="px-4 py-3"><StatusBadge tone={opStatusTone(op.status)}>{op.status}</StatusBadge></td>
                    <td className="px-4 py-3">
                      <OperationStatusActions
                        operationId={op.id}
                        status={op.status}
                        scheduledStart={op.scheduledStart.toISOString()}
                        quantity={op.productionOrder.quantity}
                        machineId={op.machineId}
                        machineName={op.machine?.name}
                        requiresInspection={op.routingOperation?.requiresInspection}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
            </JobsActionsProvider>
          </table>
        </div>
      )}
    </div>
  );
}
