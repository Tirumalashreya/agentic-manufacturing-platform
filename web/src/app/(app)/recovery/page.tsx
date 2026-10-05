import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { listPlantsForEnterprise } from "@/lib/tenant";
import { computeLatenessStatus, type LatenessStatus } from "@/lib/lateness";
import { Card } from "@/components/ui/Card";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/States";
import { OrderScheduleActions } from "@/components/OrderScheduleActions";
import { latenessTone } from "@/lib/statusTone";

export const metadata: Metadata = { title: "Recovery" };

type AuditEntry = {
  scheduledStart?: string;
  scheduledEnd?: string;
  machineId?: string | null;
  reason?: string;
  productionOrderId?: string;
};

// Real Recovery (Phase 6, agreed with the user) — visibility + a real audit
// trail only, no new scheduling actions this round. The Late/At-Risk list
// reuses the exact existing computeLatenessStatus per operation (same
// function /schedule and /my-jobs already use), rolled up to "worst status
// per order." The audit trail reads real ScheduleAuditLog rows the
// scheduling pipeline now writes on every real reschedule (previously 100%
// dead schema) — correlated back to an order via productionOrderId, which
// is baked into the real before/after JSON snapshots themselves so the
// trail stays readable even after a later reschedule further changes or
// deletes the referenced ScheduledOperation row.
export default async function RecoveryPage({
  searchParams,
}: {
  searchParams: Promise<{ plantId?: string }>;
}) {
  const session = await auth();
  const { plantId: requestedPlantId } = await searchParams;
  const plants = session?.user.enterpriseId
    ? await listPlantsForEnterprise(session.user.enterpriseId)
    : await prisma.plant.findMany({ orderBy: { code: "asc" } });
  const selectedPlant = plants.find((p) => p.id === requestedPlantId) ?? plants[0];

  if (!selectedPlant) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Recovery" />
        <EmptyState title="No plants exist yet" />
      </div>
    );
  }

  const orders = await prisma.productionOrder.findMany({
    where: { plantId: selectedPlant.id, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    include: {
      product: { select: { sku: true } },
      salesOrder: { select: { dueDate: true } },
      scheduledOperations: { select: { scheduledEnd: true, actualEnd: true, routingOperation: { select: { operation: true } } } },
    },
    orderBy: { priorityScore: "desc" },
  });

  const RANK: Record<LatenessStatus, number> = { LATE: 3, AT_RISK: 2, ON_TRACK: 1, NO_DUE_DATE: 0 };
  const atRiskOrders = orders
    .map((order) => {
      const dueDate = order.salesOrder?.dueDate ?? null;
      let worst: LatenessStatus = "NO_DUE_DATE";
      for (const op of order.scheduledOperations) {
        const status = computeLatenessStatus(op.scheduledEnd, dueDate, op.actualEnd);
        if (RANK[status] > RANK[worst]) worst = status;
      }
      return { order, worst, dueDate };
    })
    .filter((o) => o.worst === "LATE" || o.worst === "AT_RISK")
    .sort((a, b) => RANK[b.worst] - RANK[a.worst]);

  // Real, recent — entityType is always "ScheduledOperation" for what the
  // pipeline writes; grouped client-side (here, server-rendered) by the
  // productionOrderId baked into the JSON, rather than fighting Postgres
  // JSON-path query syntax for an "in this order-id list" filter.
  const recentAudit = await prisma.scheduleAuditLog.findMany({
    where: { entityType: "ScheduledOperation" },
    orderBy: { logTimestamp: "desc" },
    take: 200,
  });
  const auditByOrder = new Map<string, { logTimestamp: Date; before: AuditEntry | null; after: AuditEntry | null }[]>();
  for (const row of recentAudit) {
    const before = row.before as AuditEntry | null;
    const after = row.after as AuditEntry | null;
    const orderId = after?.productionOrderId ?? before?.productionOrderId;
    if (!orderId) continue;
    const list = auditByOrder.get(orderId) ?? [];
    list.push({ logTimestamp: row.logTimestamp, before, after });
    auditByOrder.set(orderId, list);
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Recovery"
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

      <Card className="p-0">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">Late & At-Risk Orders</h2>
          <p className="mt-1 text-xs text-muted">
            Real orders where at least one real operation is LATE or AT_RISK against its sales order&apos;s due date — same computation the Schedule and My Jobs pages already use, rolled up per order.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-surface-muted text-left text-[10px] font-bold uppercase tracking-widest text-muted">
              <tr>
                <th className="px-3 py-2">Work Order</th>
                <th className="px-3 py-2">Item</th>
                <th className="px-3 py-2">Qty</th>
                <th className="px-3 py-2">Due</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Real Reschedule History</th>
                <th className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {atRiskOrders.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-muted">No orders currently late or at risk.</td>
                </tr>
              ) : (
                atRiskOrders.map(({ order, worst, dueDate }) => {
                  const history = auditByOrder.get(order.id) ?? [];
                  return (
                    <tr key={order.id}>
                      <td className="px-3 py-2 font-mono text-xs">
                        <Link href={`/orders/${order.id}`} className="text-brand-600 hover:underline">{order.id.slice(-8)}</Link>
                      </td>
                      <td className="px-3 py-2 font-medium text-foreground">{order.product.sku}</td>
                      <td className="px-3 py-2 text-muted">{order.quantity}</td>
                      <td className="px-3 py-2 text-muted">{dueDate ? new Date(dueDate).toLocaleString() : "—"}</td>
                      <td className="px-3 py-2">
                        <StatusBadge tone={latenessTone(worst)}>{worst.replaceAll("_", " ")}</StatusBadge>
                      </td>
                      <td className="px-3 py-2 text-xs text-muted">
                        {history.length === 0 ? (
                          "No reschedule recorded yet"
                        ) : (
                          <ul className="flex flex-col gap-1">
                            {history.slice(0, 3).map((h, i) => (
                              <li key={i}>
                                {h.after ? (
                                  <>
                                    Moved to {h.after.scheduledStart ? new Date(h.after.scheduledStart).toLocaleString() : "—"}
                                    {h.before?.scheduledStart && ` (was ${new Date(h.before.scheduledStart).toLocaleString()})`}
                                    {h.after.reason && ` — ${h.after.reason}`}
                                  </>
                                ) : (
                                  <>Could not be re-placed{h.before?.reason ? ` — ${h.before.reason}` : ""}</>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <OrderScheduleActions plantId={selectedPlant.id} productionOrderId={order.id} />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
