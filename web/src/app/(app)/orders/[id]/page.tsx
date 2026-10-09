import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { fetchDelayExplanation, fetchShortages } from "@/lib/services";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { PageHeader } from "@/components/ui/PageHeader";
import { Breadcrumbs } from "@/components/ui/Breadcrumbs";
import { OperationStatusActions } from "@/components/OperationStatusActions";
import { OrderScheduleActions } from "@/components/OrderScheduleActions";
import { opStatusTone, orderStatusTone, latenessTone, fulfillmentLineStatusTone } from "@/lib/statusTone";

export const metadata: Metadata = { title: "Production order" };

// Order Detail — the control-center page the platform never had (Phase 8 of
// the discoverability pass, agreed with the user). Nothing here is a new
// backend calculation: the header/plan/materials sections are direct
// Prisma reads matching the exact patterns Orders/Production Planning
// already use, and the Schedule/Quality/Exceptions/Recovery sections are
// ALL powered by one existing call — GET /scheduling/orders/:id/
// delay-explanation (Phase 8, previously called only by the Python agent,
// never by this UI). Reusing it here rather than re-querying the same
// facts a second way is exactly the "one source of truth" principle this
// pass is trying to restore.
export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const order = await prisma.productionOrder.findUnique({
    where: { id },
    include: {
      product: true,
      plant: true,
      salesOrder: {
        include: {
          customer: true,
          // Order Control Center (Phase 3, agreed with the user): the
          // real per-line fulfillment record — same relation Ledger's
          // Fulfillment panel reads via the agent-orchestrator's REST
          // endpoint, read directly here since this page is already a
          // real-Prisma page. This ProductionOrder's own linked lines
          // (fulfillmentLines below) are the ones we actually care about;
          // orderLines is included so we can find the plan they belong to.
          orderLines: { include: { fulfillmentPlan: { include: { lines: true } } } },
        },
      },
      routing: { include: { operations: { include: { workCenter: true }, orderBy: { opNumber: "asc" } } } },
      fulfillmentLines: true,
    },
  });

  if (!order) notFound();

  const bom = order.bomId
    ? await prisma.bOM.findUnique({ where: { id: order.bomId }, include: { lines: { include: { component: true } } } })
    : await prisma.bOM.findFirst({ where: { productId: order.productId }, include: { lines: { include: { component: true } } } });

  const [delayResult, shortagesResult] = await Promise.all([fetchDelayExplanation(order.id), fetchShortages()]);

  // Order Control Center: find the real FulfillmentPlan this order's own
  // linked FulfillmentLine belongs to (there's exactly one order line per
  // sales order today — see OrderLine's own schema comment), and show
  // every leg of it (HYBRID has two: STOCK + PRODUCTION), not just this
  // ProductionOrder's own — the point is the whole real picture, same as
  // Ledger's Fulfillment panel.
  const fulfillmentPlan = order.salesOrder?.orderLines.find((l) => l.fulfillmentPlan)?.fulfillmentPlan ?? null;

  const bomComponentIds = new Set((bom?.lines ?? []).map((l) => l.componentId));
  const relevantShortages = shortagesResult.ok ? shortagesResult.data.filter((s) => bomComponentIds.has(s.productId)) : null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Breadcrumbs items={[{ label: "Production orders", href: "/orders" }, { label: `#${order.id.slice(-8)}` }]} />
        <PageHeader
          title={order.product.sku}
          description={`#${order.id.slice(-8)}`}
          actions={<StatusBadge tone={orderStatusTone(order.status)}>{order.status}</StatusBadge>}
        />
      </div>

      {/* Header */}
      <Card>
        <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <div>
            <p className="text-xs text-muted">Customer</p>
            <p className="font-medium text-foreground">{order.salesOrder?.customer.name ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs text-muted">Quantity</p>
            <p className="font-medium text-foreground">{order.quantity}</p>
          </div>
          <div>
            <p className="text-xs text-muted">Due date</p>
            <p className="font-medium text-foreground">
              {order.salesOrder?.dueDate ? new Date(order.salesOrder.dueDate).toLocaleDateString() : "— (no linked sales order)"}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted">Priority score</p>
            <p className="font-medium text-foreground">{order.priorityScore.toFixed(1)}</p>
          </div>
          <div>
            <p className="text-xs text-muted">Plant</p>
            <p className="font-medium text-foreground">{order.plant.code}</p>
          </div>
          <div>
            <p className="text-xs text-muted">Scheduled window</p>
            <p className="font-medium text-foreground">
              {order.scheduledStart ? new Date(order.scheduledStart).toLocaleDateString() : "—"}
              {" – "}
              {order.scheduledEnd ? new Date(order.scheduledEnd).toLocaleDateString() : "—"}
            </p>
          </div>
          {delayResult.ok && (
            <div>
              <p className="text-xs text-muted">Delivery status</p>
              <StatusBadge tone={latenessTone(delayResult.data.latenessStatus)}>{delayResult.data.latenessStatus.replaceAll("_", " ")}</StatusBadge>
            </div>
          )}
        </div>
      </Card>

      {/* Fulfillment — Order Control Center (Phase 3, agreed with the
      user): each fulfillment leg's own independent status, source, and
      execution reference, real and live-verified. */}
      {fulfillmentPlan && (
        <Card className="p-0">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold text-foreground">Fulfillment — {fulfillmentPlan.strategy}</h2>
            {fulfillmentPlan.reasoning && <p className="mt-1 text-xs text-muted">{fulfillmentPlan.reasoning}</p>}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-muted text-left text-[10px] font-bold uppercase tracking-widest text-muted">
                <tr>
                  <th className="px-3 py-2">Source</th>
                  <th className="px-3 py-2">Qty</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Promised</th>
                  <th className="px-3 py-2">Execution</th>
                  <th className="px-3 py-2">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {fulfillmentPlan.lines.map((line) => (
                  <tr key={line.id} className={line.productionOrderId === order.id ? "bg-surface-muted/50" : undefined}>
                    <td className="px-3 py-2 text-foreground">{line.sourceType}</td>
                    <td className="px-3 py-2 text-muted">{line.quantity}</td>
                    <td className="px-3 py-2"><StatusBadge tone={fulfillmentLineStatusTone(line.status)}>{line.status}</StatusBadge></td>
                    <td className="px-3 py-2 text-muted">{line.promisedDate ? new Date(line.promisedDate).toLocaleDateString() : "—"}</td>
                    <td className="px-3 py-2 text-muted">
                      {line.productionOrderId
                        ? line.productionOrderId === order.id
                          ? "This production order"
                          : `Production Order #${line.productionOrderId.slice(-8)}`
                        : line.executionReference
                          ? `${line.vendorName ? `${line.vendorName} — ` : ""}${line.executionReference}`
                          : "—"}
                    </td>
                    <td className="px-3 py-2 text-muted">{line.reason ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Actions — real, committing, same semantics as Ledger's own
      Reschedule/Optimize buttons (see OrderScheduleActions' own comment) */}
      <Card>
        <h2 className="mb-3 text-sm font-semibold text-foreground">Actions</h2>
        <div className="flex flex-wrap items-start gap-4">
          <OrderScheduleActions plantId={order.plantId} productionOrderId={order.id} />
          <Link href={`/schedule?plantId=${order.plantId}`} className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface-muted">
            View on Schedule
          </Link>
          <Link href={`/recovery?plantId=${order.plantId}`} className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface-muted">
            View in Recovery
          </Link>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Plan */}
        <Card className="p-0">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold text-foreground">Plan — Routing</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-muted text-left text-[10px] font-bold uppercase tracking-widest text-muted">
                <tr>
                  <th className="px-3 py-2">#</th>
                  <th className="px-3 py-2">Operation</th>
                  <th className="px-3 py-2">Work center</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {!order.routing || order.routing.operations.length === 0 ? (
                  <tr><td colSpan={3} className="px-3 py-6 text-center text-muted">No routing linked.</td></tr>
                ) : (
                  order.routing.operations.map((op) => (
                    <tr key={op.id}>
                      <td className="px-3 py-2 text-muted">{op.opNumber}</td>
                      <td className="px-3 py-2 text-foreground">
                        {op.operation}
                        {op.requiresInspection && <Badge className="ml-2 px-1.5 py-0 text-[10px]">QC</Badge>}
                      </td>
                      <td className="px-3 py-2 text-muted">{op.workCenter.code}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>

        {/* Materials — the previously-invisible real shortage scan, filtered
        to this order's own BOM components */}
        <Card className="p-0">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold text-foreground">Materials</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-muted text-left text-[10px] font-bold uppercase tracking-widest text-muted">
                <tr>
                  <th className="px-3 py-2">Component</th>
                  <th className="px-3 py-2">Qty per unit</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {!bom || bom.lines.length === 0 ? (
                  <tr><td colSpan={3} className="px-3 py-6 text-center text-muted">No BOM linked.</td></tr>
                ) : (
                  bom.lines.map((line) => {
                    const shortage = relevantShortages?.find((s) => s.productId === line.componentId);
                    return (
                      <tr key={line.id}>
                        <td className="px-3 py-2 text-foreground">{line.component.sku}</td>
                        <td className="px-3 py-2 text-muted">{line.quantityPer}</td>
                        <td className="px-3 py-2">
                          {shortagesResult.ok ? (
                            shortage ? (
                              <StatusBadge tone="danger">Short {shortage.required - shortage.available}</StatusBadge>
                            ) : (
                              <StatusBadge tone="success">OK</StatusBadge>
                            )
                          ) : (
                            <span className="text-xs text-muted">Materials service unavailable</span>
                          )}
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

      {/* Schedule, Quality, Exceptions — all from the one real
      delay-explanation composition */}
      <Card className="p-0">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">Schedule, Quality &amp; Exceptions</h2>
        </div>
        {!delayResult.ok ? (
          <p className="px-4 py-6 text-center text-sm text-muted">Scheduling service unavailable — {delayResult.error}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-muted text-left text-[10px] font-bold uppercase tracking-widest text-muted">
                <tr>
                  <th className="px-3 py-2">Operation</th>
                  <th className="px-3 py-2">Machine</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Deviation</th>
                  <th className="px-3 py-2">QC hold</th>
                  <th className="px-3 py-2">Recent exceptions</th>
                  <th className="px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {delayResult.data.operations.length === 0 ? (
                  <tr><td colSpan={7} className="px-3 py-6 text-center text-muted">No scheduled operations yet.</td></tr>
                ) : (
                  delayResult.data.operations.map((op) => (
                    <tr key={op.id}>
                      <td className="px-3 py-2 text-foreground">{op.operation ?? "—"}</td>
                      <td className="px-3 py-2 text-muted">{op.machineName ?? "—"}</td>
                      <td className="px-3 py-2"><StatusBadge tone={opStatusTone(op.status)}>{op.status}</StatusBadge></td>
                      <td className="px-3 py-2 text-muted">{op.deviationMinutes != null ? `${op.deviationMinutes} min` : "—"}</td>
                      <td className="px-3 py-2">
                        {op.qcHold?.blocked ? (
                          <StatusBadge tone="danger">Blocked — {op.qcHold.reason}</StatusBadge>
                        ) : op.qcHold ? (
                          <StatusBadge tone="success">Clear</StatusBadge>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted">
                        {op.recentExceptions.length === 0 ? "—" : op.recentExceptions.map((e) => e.type.replaceAll("_", " ")).join(", ")}
                      </td>
                      <td className="px-3 py-2">
                        <OperationStatusActions
                          operationId={op.id}
                          status={op.status}
                          scheduledStart={op.scheduledStart}
                          quantity={order.quantity}
                          requiresInspection={!!order.routing?.operations.find((r) => r.operation === op.operation)?.requiresInspection}
                        />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Delay explanation — the previously-invisible real endpoint, now
      finally getting a UI caller. Deliberately a plain fact panel, not
      styled as a chat/AI response — no LLM is involved in producing it. */}
      <Card className="p-0">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">Why is this order at risk?</h2>
          <p className="mt-1 text-xs text-muted">A deterministic composition of the real facts above — no AI involved in producing this.</p>
        </div>
        <div className="px-4 py-4 text-sm">
          {!delayResult.ok ? (
            <p className="text-muted">Unavailable — {delayResult.error}</p>
          ) : delayResult.data.latenessStatus === "ON_TRACK" || delayResult.data.latenessStatus === "NO_DUE_DATE" ? (
            <p className="text-muted">No open exceptions, QC holds, or recorded reschedules affecting this order right now.</p>
          ) : (
            <ul className="flex flex-col gap-2 text-foreground">
              {delayResult.data.operations
                .filter((op) => op.qcHold?.blocked || op.recentExceptions.some((e) => !e.resolvedAt))
                .map((op) => (
                  <li key={op.id}>
                    {op.qcHold?.blocked && <>• {op.operation} is blocked on a QC hold — {op.qcHold.reason}</>}
                    {op.recentExceptions
                      .filter((e) => !e.resolvedAt)
                      .map((e, i) => (
                        <div key={i}>• {op.operation} has an open {e.type.replaceAll("_", " ")} exception, reported {new Date(e.reportedAt).toLocaleString()}</div>
                      ))}
                  </li>
                ))}
              {delayResult.data.auditHistory.slice(0, 3).map((row, i) => {
                const reason = (row.after?.reason as string | undefined) ?? (row.before?.reason as string | undefined);
                return reason ? <li key={`audit-${i}`}>• Rescheduled: {reason}</li> : null;
              })}
            </ul>
          )}
        </div>
      </Card>

      {/* Recovery / Audit — same ScheduleAuditLog data Recovery shows,
      scoped to this one order, sourced from the same delay-explanation
      call above rather than a second query. */}
      <Card className="p-0">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">Reschedule Audit History</h2>
        </div>
        <div className="px-4 py-4 text-sm">
          {!delayResult.ok ? (
            <p className="text-muted">Unavailable — {delayResult.error}</p>
          ) : delayResult.data.auditHistory.length === 0 ? (
            <p className="text-muted">No reschedule recorded for this order yet.</p>
          ) : (
            <ul className="flex flex-col gap-1.5 text-xs text-muted">
              {delayResult.data.auditHistory.map((row, i) => (
                <li key={i}>
                  {new Date(row.logTimestamp).toLocaleString()} —{" "}
                  {row.after ? (
                    <>
                      moved to {row.after.scheduledStart ? new Date(row.after.scheduledStart as string).toLocaleString() : "—"}
                      {row.before?.scheduledStart && ` (was ${new Date(row.before.scheduledStart as string).toLocaleString()})`}
                      {row.after.reason ? ` — ${row.after.reason}` : ""}
                    </>
                  ) : (
                    <>could not be re-placed{row.before?.reason ? ` — ${row.before.reason}` : ""}</>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}
