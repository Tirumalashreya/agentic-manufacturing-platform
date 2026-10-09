import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DisruptionImpact } from "./DisruptionImpact";

describe("DisruptionImpact", () => {
  it("11 — recovery flow renders the disruption and its promise impact", () => {
    render(
      <DisruptionImpact
        disruptionType="MACHINE_BREAKDOWN"
        affectedResource="M-104"
        salesOrderId="SO-1042"
        customerName="Acme Corp"
        originalPromisedDate="2026-12-05"
        currentPromisedDate="2026-12-10"
      />
    );
    expect(screen.getByText(/DISRUPTION DETECTED/)).toBeInTheDocument();
    expect(screen.getByText("SO-1042")).toBeInTheDocument();
    expect(screen.getByText("Acme Corp")).toBeInTheDocument();
    expect(screen.getByText("12/05/2026")).toBeInTheDocument(); // original promise
    expect(screen.getByText("12/10/2026")).toBeInTheDocument(); // current projected date
    expect(screen.getByText("PROMISE AT RISK")).toBeInTheDocument();
  });

  it("13 — missing optional fields (no resource, no customer) do not crash the UI", () => {
    expect(() => render(<DisruptionImpact disruptionType="MACHINE_BREAKDOWN" />)).not.toThrow();
    expect(screen.getByText(/DISRUPTION DETECTED/)).toBeInTheDocument();
  });
});
