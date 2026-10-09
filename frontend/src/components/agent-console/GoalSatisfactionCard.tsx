import type { GoalSatisfaction } from "@/types/workflow";
import { AlertBanner } from "@/components/ui";
import { formatDate } from "@/lib/promiseUi";

// Phase 12 (brief §7/§12) — "goal_satisfaction" must come from the
// deterministic backend, never inferred from an HTTP 200. Three distinct
// states are rendered, never collapsed into two:
//   - undefined/null: no goal_satisfaction was computed at all (not every
//     approval is promise-bearing — a plain reschedule has nothing to
//     verify). Shown as a neutral, honest "not applicable," never as
//     success or failure.
//   - satisfied: true -> a real success banner.
//   - satisfied: false -> a real failure banner, with whatever reason
//     text the caller supplies (never fabricated here).
export function GoalSatisfactionCard({
  goalSatisfaction,
  failureReason,
}: {
  goalSatisfaction: GoalSatisfaction | null | undefined;
  failureReason?: string;
}) {
  if (!goalSatisfaction) {
    return (
      <div data-testid="goal-satisfaction-unknown" className="kv">
        <div className="kv-label">PROMISE RESULT</div>
        <div style={{ fontSize: 12.5, color: "var(--text-faint)", marginTop: 4 }}>
          Goal satisfaction not determined for this action.
        </div>
      </div>
    );
  }

  const { requested_quantity, fulfilled_quantity, requested_date, promised_date, satisfied } = goalSatisfaction;

  return (
    <div data-testid="goal-satisfaction" style={{ marginTop: 4 }}>
      <div className="kv-grid" style={{ marginBottom: 10 }}>
        <div className="kv">
          <div className="kv-label">REQUESTED</div>
          <div className="kv-value" style={{ fontSize: 15 }}>
            {requested_quantity != null ? `${requested_quantity} units` : "—"}
          </div>
          <div className="kv-note">by {formatDate(requested_date)}</div>
        </div>
        <div className="kv">
          <div className="kv-label">ACTUAL</div>
          <div className="kv-value" style={{ fontSize: 15 }}>
            {fulfilled_quantity != null ? `${fulfilled_quantity} units` : "—"}
          </div>
          <div className="kv-note">{formatDate(promised_date)}</div>
        </div>
      </div>

      {satisfied ? (
        <AlertBanner tone="success" title="GOAL SATISFIED ✓">
          The original request was met.
        </AlertBanner>
      ) : (
        <AlertBanner tone="danger" title="GOAL NOT SATISFIED">
          {failureReason ?? "The original request was not fully met by the actual result."}
        </AlertBanner>
      )}
    </div>
  );
}
