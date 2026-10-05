"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getOrderTracking, ApiError, type OrderTracking } from "@/lib/api";
import { StageTracker } from "@/components/manufacturing/StageTracker";

const POLL_MS = 4000;
const APS_PLATFORM_URL = process.env.NEXT_PUBLIC_APS_PLATFORM_URL ?? "http://localhost:3001";

// Order-level only (agreed with the user — the standing architecture
// principle): Ledger shows WHAT'S HAPPENING to this order in plain
// terms, not per-operation machine/operator assignment — that detail
// belongs to APS Platform, the manufacturing system of record. Computed
// entirely client-side from data already in hand; no new backend call.
function summarizeProgress(operations: { operation: string; status: string; scheduled_start: string | null; scheduled_end: string | null }[]) {
  const total = operations.length;
  const done = operations.filter((o) => o.status === "DONE").length;
  const blocked = operations.find((o) => o.status === "BLOCKED");
  const inProgress = operations.find((o) => o.status === "IN_PROGRESS");
  const current = blocked ?? inProgress ?? operations.find((o) => o.status !== "DONE") ?? null;

  const remaining = operations.filter((o) => o.status !== "DONE" && o.scheduled_end);
  const expectedCompletion = remaining.length > 0
    ? remaining.reduce((latest, o) => (o.scheduled_end! > latest ? o.scheduled_end! : latest), remaining[0].scheduled_end!)
    : null;

  return { total, done, current, expectedCompletion };
}

// Closes the real gap found live: the approval screen used to show the
// plan at the moment you approved it and never look again, so anything
// that happened afterward — an operator starting/finishing real work on
// Execution, the order-to-cash loop firing on its own once the last
// operation completed — was invisible from here. This polls the real
// production order every few seconds so this screen stays honestly live
// instead of a frozen snapshot, and links out to the actual page for
// whatever step is next rather than guessing or auto-navigating there
// (which would fight a live presenter for control of the screen).
export function TrackOrderPanel({
  productionOrderId,
  salesOrderId,
  customerName,
  productName,
  quantity,
  onGone,
}: {
  productionOrderId: string;
  salesOrderId: string | null;
  customerName: string;
  productName: string;
  quantity: number;
  // Real fix (agreed with the user): a tracked order surviving past a
  // demo-data reset used to sit here erroring on every 4s poll forever,
  // with no way to tell "genuinely gone" apart from a transient backend
  // hiccup. Called only on a confirmed 404 (see the backend's own fix in
  // production.py) — never on a generic network/500 error, which stays
  // a real order that's just temporarily unreachable, not one to drop.
  onGone?: () => void;
}) {
  const [tracking, setTracking] = useState<OrderTracking | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const data = await getOrderTracking(productionOrderId, salesOrderId);
        if (!cancelled) {
          setTracking(data);
          setError(null);
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          onGone?.();
          return;
        }
        setError(err instanceof Error ? err.message : "Could not load live status.");
      }
    }

    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productionOrderId, salesOrderId]);

  const progress = tracking ? summarizeProgress(tracking.operations) : null;
  const doneOps = progress?.done ?? 0;
  const totalOps = progress?.total ?? 0;
  const hasOpenOps = tracking ? tracking.operations.some((o) => o.status !== "DONE") : false;

  return (
    <div className="panel" style={{ borderColor: "var(--accent)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <div className="panel-title" style={{ marginBottom: 0 }}>📡 Track this order — live</div>
        <span style={{ fontSize: 10, color: "var(--text-faint)" }}>refreshes every {POLL_MS / 1000}s</span>
      </div>
      <p className="panel-sub">
        {customerName} · {quantity} × {productName}
      </p>

      {error && <p style={{ fontSize: 12, color: "var(--alert)" }}>{error}</p>}

      {!tracking && !error && <p style={{ fontSize: 12.5, color: "var(--text-soft)" }}>Loading live status…</p>}

      {tracking && (
        <>
          <div style={{ margin: "12px 0 16px" }}>
            <StageTracker status={tracking.stage} doneOps={doneOps} totalOps={totalOps} />
          </div>

          <div className="kv-grid" style={{ marginBottom: 4 }}>
            <div className="kv">
              <div className="kv-label">PROGRESS</div>
              <div className="kv-value" style={{ fontSize: 15 }}>{doneOps} of {totalOps} operations complete</div>
            </div>
            <div className="kv">
              <div className="kv-label">CURRENT OPERATION</div>
              <div className="kv-value" style={{ fontSize: 15 }}>
                {progress?.current
                  ? `${progress.current.operation}${progress.current.status === "BLOCKED" ? " (blocked)" : ""}`
                  : totalOps > 0
                  ? "All operations complete"
                  : "—"}
              </div>
            </div>
            <div className="kv">
              <div className="kv-label">EXPECTED COMPLETION</div>
              <div className="kv-value" style={{ fontSize: 15 }}>
                {progress?.expectedCompletion ? new Date(progress.expectedCompletion).toLocaleString() : "—"}
              </div>
            </div>
          </div>
          {/* Per-operation machine/operator detail intentionally stops here —
              that's APS Platform's detailed shop-floor view, not Ledger's
              (agreed with the user: order-level status only on this side). */}

          {tracking.delivery && (
            <p style={{ fontSize: 12.5, color: "var(--money)", marginTop: 12 }}>
              ✓ Delivery {tracking.delivery.delivery_id} — {tracking.delivery.status}
              {tracking.delivery.confirmed_delivery_date ? `, confirmed ${tracking.delivery.confirmed_delivery_date}` : ""}
            </p>
          )}
          {tracking.invoice && (
            <p style={{ fontSize: 12.5, color: "var(--money)", margin: "4px 0 0" }}>
              ✓ Invoice {tracking.invoice.invoice_id} — ₹{tracking.invoice.invoice_amount.toLocaleString()} — {tracking.invoice.status}
            </p>
          )}

          <div style={{ display: "flex", gap: 14, marginTop: 14, flexWrap: "wrap" }}>
            {hasOpenOps && (
              <a
                href={`${APS_PLATFORM_URL}/my-jobs`}
                target="_blank"
                rel="noopener noreferrer"
                className="btn secondary"
                style={{ fontSize: 11, padding: "5px 12px" }}
              >
                Work this order on APS Platform ↗
              </a>
            )}
            <Link href="/production-planning" className="btn secondary" style={{ fontSize: 11, padding: "5px 12px" }}>
              View in Production Planning →
            </Link>
            {tracking.invoice && (
              <Link href="/billing" className="btn secondary" style={{ fontSize: 11, padding: "5px 12px" }}>
                View in Billing →
              </Link>
            )}
          </div>
        </>
      )}
    </div>
  );
}
