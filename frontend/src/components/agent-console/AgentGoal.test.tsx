import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgentGoal } from "./AgentGoal";

describe("AgentGoal", () => {
  it("renders an order-promise goal with customer/product/quantity/date", () => {
    render(<AgentGoal goalType="ORDER_PROMISE" customerName="Acme Corp" productName="Cable Management Kit" quantity={500} requestedDate="2026-12-05" />);
    expect(screen.getByText("GOAL")).toBeInTheDocument();
    expect(screen.getByText(/500 × Cable Management Kit/)).toBeInTheDocument();
    expect(screen.getByText(/Acme Corp/)).toBeInTheDocument();
  });

  it("labels a recovery goal distinctly as RECOVERY GOAL", () => {
    render(<AgentGoal goalType="PROMISE_RECOVERY" customerName="Acme Corp" productName="Cable Management Kit" quantity={500} requestedDate="2026-12-05" />);
    expect(screen.getByText("RECOVERY GOAL")).toBeInTheDocument();
  });

  it("13 — missing optional fields do not crash the UI", () => {
    expect(() => render(<AgentGoal goalType="ORDER_PROMISE" />)).not.toThrow();
    expect(screen.getByText("Goal details unavailable")).toBeInTheDocument();
  });
});
