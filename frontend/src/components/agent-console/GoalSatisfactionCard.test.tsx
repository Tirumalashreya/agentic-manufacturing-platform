import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { GoalSatisfactionCard } from "./GoalSatisfactionCard";
import type { GoalSatisfaction } from "@/types/workflow";

describe("GoalSatisfactionCard", () => {
  it("9 — goal_satisfaction satisfied: true renders a success state", () => {
    const gs: GoalSatisfaction = {
      requested_quantity: 500, fulfilled_quantity: 500,
      requested_date: "2026-12-05", promised_date: "2026-12-05", satisfied: true,
    };
    render(<GoalSatisfactionCard goalSatisfaction={gs} />);
    expect(screen.getByText("GOAL SATISFIED ✓")).toBeInTheDocument();
    expect(screen.queryByText("GOAL NOT SATISFIED")).toBeNull();
  });

  it("10 — goal_satisfaction satisfied: false renders a failure state, never success", () => {
    const gs: GoalSatisfaction = {
      requested_quantity: 500, fulfilled_quantity: 500,
      requested_date: "2026-12-05", promised_date: "2026-12-10", satisfied: false,
    };
    render(<GoalSatisfactionCard goalSatisfaction={gs} />);
    expect(screen.getByText("GOAL NOT SATISFIED")).toBeInTheDocument();
    expect(screen.queryByText("GOAL SATISFIED ✓")).toBeNull();
  });

  it("renders a distinct 'not determined' state for null/undefined — never shown as satisfied or failed", () => {
    render(<GoalSatisfactionCard goalSatisfaction={null} />);
    expect(screen.getByTestId("goal-satisfaction-unknown")).toBeInTheDocument();
    expect(screen.queryByText("GOAL SATISFIED ✓")).toBeNull();
    expect(screen.queryByText("GOAL NOT SATISFIED")).toBeNull();
  });

  it("13 — missing optional quantity/date fields do not crash the UI", () => {
    const gs: GoalSatisfaction = {
      requested_quantity: null, fulfilled_quantity: null,
      requested_date: null, promised_date: null, satisfied: false,
    };
    expect(() => render(<GoalSatisfactionCard goalSatisfaction={gs} />)).not.toThrow();
  });

  it("renders a supplied failure reason verbatim, never a fabricated one", () => {
    const gs: GoalSatisfaction = {
      requested_quantity: 500, fulfilled_quantity: 500,
      requested_date: "2026-12-05", promised_date: "2026-12-10", satisfied: false,
    };
    render(<GoalSatisfactionCard goalSatisfaction={gs} failureReason="No currently supported recovery option restores Friday." />);
    expect(screen.getByText("No currently supported recovery option restores Friday.")).toBeInTheDocument();
  });
});
