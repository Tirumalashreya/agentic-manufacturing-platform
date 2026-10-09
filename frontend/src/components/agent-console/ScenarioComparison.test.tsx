import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScenarioComparison } from "./ScenarioComparison";
import type { PromiseScenario } from "@/types/workflow";

function scenario(overrides: Partial<PromiseScenario>): PromiseScenario {
  return {
    scenario_id: "STOCK_PLUS_PRODUCTION",
    label: "Stock + Production",
    quantity_from_stock: 200,
    quantity_to_make: 300,
    quantity_from_vendor: 0,
    requested_delivery_date: "2026-12-05",
    projected_delivery_date: "2026-12-04",
    feasible: true,
    production_status: "PASS",
    risk_flags: [],
    ...overrides,
  };
}

describe("ScenarioComparison", () => {
  it("1 — renders a single promise scenario with its real evidence", () => {
    render(<ScenarioComparison scenarios={[scenario({})]} recommendedScenarioId={null} />);
    expect(screen.getByText("Stock + Production")).toBeInTheDocument();
    expect(screen.getByText(/Delivery: 12\/04\/2026/)).toBeInTheDocument();
  });

  it("2 — renders multiple alternatives, one card per scenario", () => {
    const scenarios = [
      scenario({ scenario_id: "A", label: "Option A" }),
      scenario({ scenario_id: "B", label: "Option B" }),
      scenario({ scenario_id: "C", label: "Option C" }),
    ];
    render(<ScenarioComparison scenarios={scenarios} recommendedScenarioId={null} />);
    expect(screen.getByTestId("scenario-A")).toBeInTheDocument();
    expect(screen.getByTestId("scenario-B")).toBeInTheDocument();
    expect(screen.getByTestId("scenario-C")).toBeInTheDocument();
  });

  it("3 — clearly identifies the recommended scenario, and only that one", () => {
    const scenarios = [
      scenario({ scenario_id: "A", label: "Option A" }),
      scenario({ scenario_id: "B", label: "Option B" }),
    ];
    render(<ScenarioComparison scenarios={scenarios} recommendedScenarioId="B" />);
    const optionB = screen.getByTestId("scenario-B");
    const optionA = screen.getByTestId("scenario-A");
    expect(optionB.querySelector('[data-testid="scenario-recommended-badge"]')).not.toBeNull();
    expect(optionA.querySelector('[data-testid="scenario-recommended-badge"]')).toBeNull();
  });

  it("4 — feasible: true renders as Feasible", () => {
    render(<ScenarioComparison scenarios={[scenario({ feasible: true })]} recommendedScenarioId={null} />);
    expect(screen.getByText("Feasible")).toBeInTheDocument();
  });

  it("5 — feasible: false renders as Not feasible", () => {
    render(<ScenarioComparison scenarios={[scenario({ feasible: false })]} recommendedScenarioId={null} />);
    expect(screen.getByText("Not feasible")).toBeInTheDocument();
  });

  it("6 — feasible: null renders 'Outcome unknown until execution', never Feasible/Infeasible", () => {
    render(<ScenarioComparison scenarios={[scenario({ feasible: null })]} recommendedScenarioId={null} />);
    expect(screen.getByText("Outcome unknown until execution")).toBeInTheDocument();
    expect(screen.queryByText("Feasible")).toBeNull();
    expect(screen.queryByText("Not feasible")).toBeNull();
  });

  it("Phase 13 — a feasible: true, promise_restored: false scenario shows both facts, not just one", () => {
    render(
      <ScenarioComparison
        scenarios={[scenario({ feasible: true, promise_restored: false, failure_reason: "Still after the original promise." })]}
        recommendedScenarioId={null}
      />
    );
    expect(screen.getByText("Feasible")).toBeInTheDocument();
    expect(screen.getByText("Promise not restored")).toBeInTheDocument();
    expect(screen.getByText("Still after the original promise.")).toBeInTheDocument();
  });

  it("Phase 13 — promise_restored: undefined (not applicable) renders no promise-restoration badge at all", () => {
    render(<ScenarioComparison scenarios={[scenario({ promise_restored: undefined })]} recommendedScenarioId={null} />);
    expect(screen.queryByText("Promise restored")).toBeNull();
    expect(screen.queryByText("Promise not restored")).toBeNull();
  });

  it("12 — an empty alternatives list is handled explicitly, not rendered as a blank/broken grid", () => {
    render(<ScenarioComparison scenarios={[]} recommendedScenarioId={null} />);
    expect(screen.getByTestId("scenario-comparison-empty")).toBeInTheDocument();
  });

  it("13 — a scenario missing optional fields (evidence/assumptions) does not crash", () => {
    const minimal: PromiseScenario = {
      scenario_id: "KEEP_CURRENT",
      label: "Keep Current",
      quantity_from_stock: 0,
      quantity_to_make: 500,
      quantity_from_vendor: 0,
      requested_delivery_date: null,
      projected_delivery_date: null,
      feasible: false,
      production_status: null,
      risk_flags: [],
    };
    expect(() => render(<ScenarioComparison scenarios={[minimal]} recommendedScenarioId={null} />)).not.toThrow();
    expect(screen.getByText("Keep Current")).toBeInTheDocument();
  });
});
