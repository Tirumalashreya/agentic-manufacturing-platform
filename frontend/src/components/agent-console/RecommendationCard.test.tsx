import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RecommendationCard } from "./RecommendationCard";
import type { PromiseScenario } from "@/types/workflow";

const scenario: PromiseScenario = {
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
};

describe("RecommendationCard", () => {
  it("renders the recommended scenario's label and the WHY reasoning", () => {
    render(<RecommendationCard scenario={scenario} reasoning="Meets the requested Friday delivery without vendor dependency." />);
    expect(screen.getByText("Stock + Production")).toBeInTheDocument();
    expect(screen.getByText(/Meets the requested Friday delivery/)).toBeInTheDocument();
  });

  it("13 — a null recommendation (no feasible option found) does not crash and is shown distinctly", () => {
    expect(() => render(<RecommendationCard scenario={null} reasoning="No option restores the original date." />)).not.toThrow();
    expect(screen.getByTestId("recommendation-none")).toBeInTheDocument();
    expect(screen.queryByTestId("recommendation-card")).toBeNull();
  });

  it("renders feasible: null as unknown, not as feasible, inside the recommendation itself", () => {
    render(<RecommendationCard scenario={{ ...scenario, feasible: null }} reasoning="Worth attempting." />);
    expect(screen.getByText("Outcome unknown until execution")).toBeInTheDocument();
  });
});
