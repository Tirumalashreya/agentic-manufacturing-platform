"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { rescheduleSalesOrder, previewSalesOrderReschedule, type RescheduleResult, type RescheduleKind } from "@/lib/api";

// Real, committing — only buildable once scheduling-service's SINGLE/
// AFFECTED scope actually narrowed itself to real orders (see
// pipeline.ts) instead of silently rescheduling the whole plant.
// Reschedule = scope SINGLE (only this order, every other order's
// existing placements are left untouched). Optimize = scope AFFECTED
// (this order plus any other real order sharing its work centers) —
// labeled honestly below using the real returned scopedOrderIds, never
// a generic claim. A preview (also real, also non-committing) is fetched
// on load so the button copy always reflects the real affected set
// before anything is clicked, not just after.
export function RescheduleActions({ salesOrderId }: { salesOrderId: string }) {
  const router = useRouter();
  const [running, setRunning] = useState<RescheduleKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ kind: RescheduleKind; data: RescheduleResult } | null>(null);
  const [affectedCount, setAffectedCount] = useState<number | null>(null);
  const [previewLoaded, setPreviewLoaded] = useState(false);

  // Fetch the real AFFECTED preview once on mount — this is what lets
  // "Optimize" honestly say how many other orders it would touch before
  // it's ever clicked.
  useEffect(() => {
    previewSalesOrderReschedule(salesOrderId, "optimize")
      .then((p) => setAffectedCount(p.scopedOrderIds.length - 1))
      .catch(() => setAffectedCount(null))
      .finally(() => setPreviewLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [salesOrderId]);

  async function run(kind: RescheduleKind) {
    setRunning(kind);
    setError(null);
    setResult(null);
    try {
      const data = await rescheduleSalesOrder(salesOrderId, kind);
      setResult({ kind, data });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reschedule failed.");
    } finally {
      setRunning(null);
    }
  }

  const optimizeLabel =
    previewLoaded && affectedCount !== null
      ? affectedCount > 0
        ? `Optimize (this order + ${affectedCount} other order${affectedCount === 1 ? "" : "s"} sharing its work centers) →`
        : "Optimize (no other order currently shares its work centers) →"
      : "Optimize →";

  return (
    <div style={{ borderTop: "1px solid var(--line)", paddingTop: 16, marginTop: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>Reschedule / Optimize</div>
      <p style={{ fontSize: 11.5, color: "var(--text-faint)", margin: "0 0 10px" }}>
        Real and committing. Reschedule touches only this order. Optimize also re-sequences any other real order
        sharing its work centers — labeled above with the real count before you click it.
      </p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button type="button" className="btn secondary" disabled={running !== null} style={{ fontSize: 11.5, padding: "6px 12px" }} onClick={() => run("reschedule")}>
          {running === "reschedule" ? "Rescheduling…" : "Reschedule (this order only) →"}
        </button>
        <button type="button" className="btn secondary" disabled={running !== null} style={{ fontSize: 11.5, padding: "6px 12px" }} onClick={() => run("optimize")}>
          {running === "optimize" ? "Optimizing…" : optimizeLabel}
        </button>
      </div>

      {error && <p style={{ fontSize: 12, color: "var(--alert)", marginTop: 10 }}>{error}</p>}

      {result && (
        <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: 6, background: "var(--money-soft)", border: "1px solid var(--money)" }}>
          <p style={{ fontSize: 12.5, color: "var(--money)", margin: 0, fontWeight: 600 }}>
            ✓ {result.kind === "reschedule" ? "Reschedule" : "Optimize"} committed — scope: {result.data.scope}
          </p>
          <p style={{ fontSize: 12, color: "var(--text-soft)", margin: "4px 0 0" }}>
            {result.data.ordersProcessed} order(s) actually rescheduled, {result.data.operationsScheduled} operation(s) scheduled,{" "}
            {result.data.conflictsDetected} conflict(s) detected. Schedule and APS Status above now reflect the real result.
          </p>
        </div>
      )}
    </div>
  );
}
