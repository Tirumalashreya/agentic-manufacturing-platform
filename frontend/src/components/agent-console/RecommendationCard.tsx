import type { PromiseScenario } from "@/types/workflow";
import { StatusBadge } from "@/components/ui";
import { feasibilityLabel, formatDate, promiseRestoredLabel } from "@/lib/promiseUi";

// Phase 12 (brief §4/§9) — the "RECOMMENDED" + "WHY" block. `reasoning`
// is LLM-authored explanation text, shown as-is (never executed, never
// treated as authoritative) — the scenario's own fields (feasible,
// projected_delivery_date, risk_flags) are the deterministic facts it's
// explaining, rendered from the same backend data ScenarioComparison
// uses, never recomputed here.
export function RecommendationCard({
  scenario,
  reasoning,
}: {
  scenario: PromiseScenario | null;
  reasoning?: string;
}) {
  if (!scenario) {
    return (
      <div data-testid="recommendation-none" className="kv" style={{ borderColor: "var(--alert)" }}>
        <div className="kv-label">RECOMMENDATION</div>
        <div style={{ fontSize: 13, color: "var(--text-soft)", marginTop: 4 }}>
          No option was recommended — nothing currently investigated restores the original goal.
        </div>
        {reasoning && <p style={{ fontSize: 11.5, color: "var(--text-faint)", marginTop: 6 }}>{reasoning}</p>}
      </div>
    );
  }

  const feasibility = feasibilityLabel(scenario.feasible);
  const promiseRestored = promiseRestoredLabel(scenario.promise_restored);
  return (
    <div data-testid="recommendation-card" className="kv" style={{ borderColor: "var(--accent)" }}>
      <div className="kv-label">RECOMMENDED</div>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 16, fontWeight: 700, color: "var(--text)", marginTop: 2 }}>
        {scenario.label}
      </div>
      <div style={{ fontSize: 12.5, color: "var(--text-soft)", marginTop: 4, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <span>Delivery: {formatDate(scenario.projected_delivery_date)}</span>
        <StatusBadge tone={feasibility.tone}>{feasibility.text}</StatusBadge>
        {promiseRestored && <StatusBadge tone={promiseRestored.tone}>{promiseRestored.text}</StatusBadge>}
      </div>
      {scenario.failure_reason && (
        <p style={{ fontSize: 11.5, color: "var(--text-faint)", marginTop: 6, marginBottom: 0 }}>{scenario.failure_reason}</p>
      )}
      {reasoning && (
        <p style={{ fontSize: 12, color: "var(--text-soft)", marginTop: 8, marginBottom: 0 }}>
          <span className="kv-label">WHY&nbsp;</span>
          {reasoning}
        </p>
      )}
    </div>
  );
}
