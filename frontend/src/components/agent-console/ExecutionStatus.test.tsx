import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ExecutionStatus } from "./ExecutionStatus";

describe("ExecutionStatus", () => {
  it("7 — approval state (approved, not yet executing) renders correctly", () => {
    render(<ExecutionStatus state="approved" />);
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(screen.queryByText("Completed")).toBeNull();
    expect(screen.queryByText("Execution Failed")).toBeNull();
  });

  it("renders the executing state distinctly from completed", () => {
    render(<ExecutionStatus state="executing" />);
    expect(screen.getByText("Executing…")).toBeInTheDocument();
    expect(screen.queryByText("Completed")).toBeNull();
  });

  it("8 — execution failure never renders a Completed/success state", () => {
    render(<ExecutionStatus state="failed" />);
    expect(screen.getByText("Execution Failed")).toBeInTheDocument();
    expect(screen.queryByText("Completed")).toBeNull();
  });

  it("renders Completed only on a genuine completed state", () => {
    render(<ExecutionStatus state="completed" />);
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.queryByText("Execution Failed")).toBeNull();
  });
});
