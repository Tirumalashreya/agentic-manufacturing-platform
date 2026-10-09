import { describe, expect, it } from "vitest";
import { feasibilityLabel, formatDate, promiseRestoredLabel } from "./promiseUi";

describe("feasibilityLabel", () => {
  it("4 — renders feasible: true as Feasible", () => {
    expect(feasibilityLabel(true)).toEqual({ text: "Feasible", tone: "success" });
  });

  it("5 — renders feasible: false as Not feasible", () => {
    expect(feasibilityLabel(false)).toEqual({ text: "Not feasible", tone: "danger" });
  });

  it("6 — renders feasible: null as unknown-until-execution, never Feasible or Infeasible", () => {
    const result = feasibilityLabel(null);
    expect(result.text).toBe("Outcome unknown until execution");
    expect(result.text).not.toMatch(/^Feasible$/);
    expect(result.text).not.toMatch(/^Not feasible$/);
  });
});

describe("promiseRestoredLabel", () => {
  it("Phase 13 — renders promise_restored: true distinctly from feasible", () => {
    expect(promiseRestoredLabel(true)).toEqual({ text: "Promise restored", tone: "success" });
  });

  it("renders promise_restored: false as a real failure, not hidden", () => {
    expect(promiseRestoredLabel(false)).toEqual({ text: "Promise not restored", tone: "danger" });
  });

  it("renders null/undefined as 'nothing to show', never as 'not restored'", () => {
    expect(promiseRestoredLabel(null)).toBeNull();
    expect(promiseRestoredLabel(undefined)).toBeNull();
  });
});

describe("formatDate", () => {
  it("formats a plain calendar date without a timezone-driven day shift", () => {
    expect(formatDate("2026-12-05")).toBe("12/05/2026");
  });

  it("returns an em dash for missing values, never crashes", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate(undefined)).toBe("—");
  });

  it("passes through an unparseable string unchanged rather than throwing", () => {
    expect(formatDate("not-a-date")).toBe("not-a-date");
  });
});
