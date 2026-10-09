import type { PromiseScenario } from "@/types/workflow";
import { StatusBadge } from "@/components/ui";
import { feasibilityLabel, formatDate, promiseRestoredLabel } from "@/lib/promiseUi";

// Phase 12 (brief §4) — renders the backend's already-computed
// scenarios/alternatives verbatim. Deliberately does NOT recompute or
// reinterpret feasible/projected_delivery_date/risk_flags — every value
// shown here came straight from a real deterministic simulation (or,
// for feasible: null, an honest statement that none exists). This
// component never calls an LLM and never guesses; it only lays out facts
// the backend already decided.
export function ScenarioComparison({
  scenarios,
  recommendedScenarioId,
}: {
  scenarios: PromiseScenario[];
  recommendedScenarioId?: string | null;
}) {
  if (scenarios.length === 0) {
    return (
      <p data-testid="scenario-comparison-empty" style={{ fontSize: 12, color: "var(--text-faint)" }}>
        No alternative scenarios were investigated.
      </p>
    );
  }

  return (
    <div data-testid="scenario-comparison" className="kv-grid">
      {scenarios.map((scenario) => {
        const isRecommended = scenario.scenario_id === recommendedScenarioId;
        const feasibility = feasibilityLabel(scenario.feasible);
        const promiseRestored = promiseRestoredLabel(scenario.promise_restored);
        return (
          <div
            key={scenario.scenario_id}
            data-testid={`scenario-${scenario.scenario_id}`}
            className="kv"
            style={isRecommended ? { borderColor: "var(--accent)", boxShadow: "0 0 0 1px var(--accent)" } : undefined}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div className="kv-label">{scenario.label}</div>
              {isRecommended && (
                <span className="chip ok" style={{ fontSize: 9.5 }} data-testid="scenario-recommended-badge">
                  RECOMMENDED
                </span>
              )}
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginTop: 4 }}>
              Delivery: {formatDate(scenario.projected_delivery_date)}
            </div>
            <div style={{ marginTop: 4, display: "flex", gap: 6, flexWrap: "wrap" }}>
              <StatusBadge tone={feasibility.tone}>{feasibility.text}</StatusBadge>
              {promiseRestored && (
                <span data-testid={`scenario-${scenario.scenario_id}-promise-restored`}>
                  <StatusBadge tone={promiseRestored.tone}>{promiseRestored.text}</StatusBadge>
                </span>
              )}
            </div>
            {scenario.failure_reason && (
              <p style={{ margin: "8px 0 0", fontSize: 11, color: "var(--text-soft)" }}>{scenario.failure_reason}</p>
            )}
            {scenario.risk_flags.length > 0 && (
              <ul style={{ margin: "8px 0 0", paddingLeft: 16, fontSize: 11, color: "var(--text-soft)" }}>
                {scenario.risk_flags.map((flag, i) => (
                  <li key={i}>{flag}</li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
