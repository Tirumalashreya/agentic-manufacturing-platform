"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { previewOrderRescheduleAction, rescheduleOrderAction } from "@/app/(app)/actions";

type Kind = "reschedule" | "optimize";
const KIND_TO_SCOPE: Record<Kind, "SINGLE" | "AFFECTED"> = { reschedule: "SINGLE", optimize: "AFFECTED" };
const KIND_TO_MODE: Record<Kind, "FORWARD" | "BOTTLENECK"> = { reschedule: "FORWARD", optimize: "BOTTLENECK" };

// The first per-order Reschedule/Optimize trigger inside APS Platform's
// own UI (agreed with the user) — this capability previously existed only
// via Ledger (chat, or the Sales Order detail page's RescheduleActions),
// even though the real underlying route (/api/reschedule) works
// identically regardless of caller.
//
// IMPORTANT — approval semantics (flagged and investigated before this was
// written, per the user's explicit correction): this deliberately mirrors
// RescheduleActions.tsx's real, already-shipped behavior exactly — a real
// read-only preview (/api/reschedule-preview) informs the button label
// before anything is clicked, and the click itself commits immediately.
// There is no separate server-side approval step to preserve here, because
// none exists in the real precedent this reuses: sales_orders.py's
// reschedule_sales_order and /api/reschedule's own route both commit
// directly off one call, with no pending-approval object, confirmed by
// reading both before writing this component. This does not introduce a
// weaker gate than what already exists elsewhere in the system, and
// deliberately does not invent a new, stricter, inconsistent one either.
export function OrderScheduleActions({ plantId, productionOrderId }: { plantId: string; productionOrderId: string }) {
  const router = useRouter();
  const [running, setRunning] = useState<Kind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ kind: Kind; scope: string; ordersProcessed: number; operationsScheduled: number; conflictsDetected: number } | null>(null);
  const [affectedCount, setAffectedCount] = useState<number | null>(null);
  const [previewLoaded, setPreviewLoaded] = useState(false);

  useEffect(() => {
    previewOrderRescheduleAction(plantId, productionOrderId, "AFFECTED")
      .then((r) => setAffectedCount(r.ok ? r.scopedOrderIds.length - 1 : null))
      .finally(() => setPreviewLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plantId, productionOrderId]);

  async function run(kind: Kind) {
    setRunning(kind);
    setError(null);
    setResult(null);
    const r = await rescheduleOrderAction(plantId, productionOrderId, KIND_TO_SCOPE[kind], KIND_TO_MODE[kind]);
    if (r.ok) {
      setResult({ kind, scope: r.scope, ordersProcessed: r.ordersProcessed, operationsScheduled: r.operationsScheduled, conflictsDetected: r.conflictsDetected });
      router.refresh();
    } else {
      setError(r.error);
    }
    setRunning(null);
  }

  const optimizeLabel =
    previewLoaded && affectedCount !== null
      ? affectedCount > 0
        ? `Optimize (this order + ${affectedCount} other order${affectedCount === 1 ? "" : "s"} sharing its work centers)`
        : "Optimize (no other order currently shares its work centers)"
      : "Optimize";

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted">
        Real and committing — nothing is a preview past this point. Reschedule touches only this order; Optimize also
        re-sequences any other real order sharing its work centers, labeled above with the real count.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={running !== null}
          onClick={() => run("reschedule")}
          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface-muted disabled:opacity-50"
        >
          {running === "reschedule" ? "Rescheduling…" : "Reschedule (this order only)"}
        </button>
        <button
          type="button"
          disabled={running !== null}
          onClick={() => run("optimize")}
          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface-muted disabled:opacity-50"
        >
          {running === "optimize" ? "Optimizing…" : optimizeLabel}
        </button>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      {result && (
        <p className="text-xs text-success">
          ✓ {result.kind === "reschedule" ? "Reschedule" : "Optimize"} committed — scope {result.scope}:{" "}
          {result.ordersProcessed} order(s) rescheduled, {result.operationsScheduled} operation(s) scheduled,{" "}
          {result.conflictsDetected} conflict(s) detected.
        </p>
      )}
    </div>
  );
}
