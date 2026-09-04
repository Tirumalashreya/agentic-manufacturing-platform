"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { fetchLeadTimePreviewAction } from "@/app/(app)/actions";
import type { LeadTimePreviewOrder } from "@/lib/services";

// §6 "Infinite (Load Analysis)": rough-cut, capacity-blind projection —
// pure lead-time math, no machine/capacity check, nothing committed. Kept
// separate from Run scheduling (which always writes a real, conflict-free
// committed schedule) so the distinction is visible in the UI, not just the API.
export function LeadTimePreview({ plantId }: { plantId: string }) {
  const [isPending, startTransition] = useTransition();
  const [orders, setOrders] = useState<LeadTimePreviewOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleClick() {
    setError(null);
    startTransition(async () => {
      const result = await fetchLeadTimePreviewAction(plantId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOrders(result.result.orders);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <Button variant="secondary" size="sm" onClick={handleClick} disabled={isPending}>
        {isPending ? "Computing..." : "Lead-time preview (rough-cut, no capacity check)"}
      </Button>
      {error && <p className="text-sm text-red-500">{error}</p>}
      {orders && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-surface-muted text-left text-[10px] font-bold uppercase tracking-widest text-muted">
              <tr>
                <th className="px-3 py-2">Product</th>
                <th className="px-3 py-2">Due Date</th>
                <th className="px-3 py-2">Projected Completion</th>
                <th className="px-3 py-2">Operations (lead-time only, no capacity)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {orders.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-muted">No open orders.</td>
                </tr>
              ) : (
                orders.map((order) => (
                  <tr key={order.productionOrderId}>
                    <td className="px-3 py-2 font-medium text-foreground">{order.productSku}</td>
                    <td className="px-3 py-2 text-muted">
                      {order.dueDate ? new Date(order.dueDate).toLocaleDateString() : "—"}
                    </td>
                    <td className="px-3 py-2 text-muted">
                      {order.projectedCompletion ? new Date(order.projectedCompletion).toLocaleString() : "—"}
                    </td>
                    <td className="px-3 py-2 text-muted">
                      {order.operations.map((op) => (
                        <span
                          key={op.routingOperationId}
                          className={op.isCritical ? "mr-2 font-semibold text-orange-500" : "mr-2"}
                        >
                          {op.operation}
                        </span>
                      ))}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
