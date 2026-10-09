import { AlertBanner } from "@/components/ui";
import { formatDate } from "@/lib/promiseUi";

// Phase 12 (brief §8) — the disruption-recovery entry point's own header:
// what broke, and what it threatens. Rendered only for a PROMISE_RECOVERY
// proposal (see pending_approval.preview.goal_type). Every value here is
// the real disruption event scheduling-service's checkPromiseImpact
// already computed (pipeline.ts) — nothing is inferred or guessed in
// this component.
export function DisruptionImpact({
  disruptionType,
  affectedResource,
  salesOrderId,
  customerName,
  originalPromisedDate,
  currentPromisedDate,
}: {
  disruptionType?: string | null;
  affectedResource?: string | null;
  salesOrderId?: string | null;
  customerName?: string | null;
  originalPromisedDate?: string | null;
  currentPromisedDate?: string | null;
}) {
  const disruptionLabel = disruptionType ? disruptionType.replace(/_/g, " ").toLowerCase() : "disruption";

  return (
    <div data-testid="disruption-impact" style={{ marginBottom: 14 }}>
      <AlertBanner tone="warning" title={`⚠ DISRUPTION DETECTED`}>
        {affectedResource ? `${affectedResource} — ${disruptionLabel}.` : `A ${disruptionLabel} occurred.`}
      </AlertBanner>

      <div className="kv-grid" style={{ marginTop: 10 }}>
        <div className="kv">
          <div className="kv-label">ORDER</div>
          <div className="kv-value" style={{ fontSize: 15 }}>{salesOrderId ?? "—"}</div>
          {customerName && <div className="kv-note">{customerName}</div>}
        </div>
        <div className="kv">
          <div className="kv-label">ORIGINAL PROMISE</div>
          <div className="kv-value" style={{ fontSize: 15 }}>{formatDate(originalPromisedDate)}</div>
        </div>
        <div className="kv" style={{ borderColor: "var(--alert)" }}>
          <div className="kv-label">CURRENT PROJECTED DATE</div>
          <div className="kv-value" style={{ fontSize: 15, color: "var(--alert)" }}>{formatDate(currentPromisedDate)}</div>
          <div className="kv-note" style={{ color: "var(--alert)" }}>PROMISE AT RISK</div>
        </div>
      </div>
    </div>
  );
}
