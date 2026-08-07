import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { OperatorPicker } from "@/components/OperatorPicker";
import { OperationStatusActions } from "@/components/OperationStatusActions";
import { computeLatenessStatus } from "@/lib/lateness";

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
          routingOperation: { select: { operation: true } },
          machine: { select: { name: true } },
        },
        orderBy: { scheduledStart: "asc" },
      })
    : [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-foreground">My Jobs</h1>
        <OperatorPicker operators={operators} selectedOperatorId={selectedOperator?.id} />
      </div>

      {!selectedOperator ? (
        <p className="text-sm text-muted">Select an operator to see their assigned jobs.</p>
      ) : ops.length === 0 ? (
        <p className="text-sm text-muted">No jobs currently assigned to {selectedOperator.name}.</p>
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
                      {latenessStatus === "LATE" && <span className="ml-2 text-red-500">Late</span>}
                      {latenessStatus === "AT_RISK" && <span className="ml-2 text-amber-500">At risk</span>}
                    </td>
                    <td className="px-4 py-3 text-muted">{op.status}</td>
                    <td className="px-4 py-3">
                      <OperationStatusActions
                        operationId={op.id}
                        status={op.status}
                        scheduledStart={op.scheduledStart.toISOString()}
                        quantity={op.productionOrder.quantity}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
