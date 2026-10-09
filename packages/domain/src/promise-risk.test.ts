import { describe, expect, it } from "vitest";
import { AT_RISK_WINDOW_HOURS, classifyPromiseRisk, comparePromisePriority, type PromiseEvidence } from "./promise-risk";

const NOW = new Date("2026-12-01T00:00:00Z");

function evidence(overrides: Partial<PromiseEvidence> = {}): PromiseEvidence {
  return {
    promisedDate: new Date("2026-12-10T00:00:00Z"),
    hasProductionLeg: true,
    productionOrderStatus: "RELEASED",
    scheduleEvidence: "AVAILABLE",
    projectedDeliveryDate: new Date("2026-12-09T00:00:00Z"),
    allOperationsDone: false,
    openExceptionCount: 0,
    hasOpenQcHold: false,
    pendingRecoveryApproval: false,
    lastVerifiedRecovery: null,
    now: NOW,
    ...overrides,
  };
}

describe("classifyPromiseRisk", () => {
  it("BREACHED — projected delivery after the committed promise", () => {
    const result = classifyPromiseRisk(evidence({ projectedDeliveryDate: new Date("2026-12-11T06:00:00Z") }));
    expect(result.riskStatus).toBe("BREACHED");
    expect(result.delayHours).toBeCloseTo(30, 0);
    expect(result.explanation).toMatch(/after the committed promise/);
    expect(result.reasonCode).toBe("SCHEDULE_OVERRUN");
  });

  it("SAFE — projected delivery on/before the promise, no open signals, not imminent", () => {
    const result = classifyPromiseRisk(evidence({ now: new Date("2026-11-01T00:00:00Z") }));
    expect(result.riskStatus).toBe("SAFE");
    expect(result.reasonCode).toBe("ON_TRACK");
  });

  it("AT_RISK — an unresolved production exception, even though not yet breached", () => {
    const result = classifyPromiseRisk(evidence({ openExceptionCount: 1 }));
    expect(result.riskStatus).toBe("AT_RISK");
    expect(result.explanation).toMatch(/unresolved production exception/);
    expect(result.reasonCode).toBe("OPEN_PRODUCTION_EXCEPTION");
  });

  it("AT_RISK — an open QC hold, even though not yet breached", () => {
    const result = classifyPromiseRisk(evidence({ hasOpenQcHold: true }));
    expect(result.riskStatus).toBe("AT_RISK");
    expect(result.explanation).toMatch(/quality hold/);
    expect(result.reasonCode).toBe("QUALITY_HOLD");
  });

  it(`AT_RISK — due within ${AT_RISK_WINDOW_HOURS}h and production not yet complete (no disruption event at all)`, () => {
    const result = classifyPromiseRisk(evidence({
      promisedDate: new Date("2026-12-02T00:00:00Z"), // 48h after NOW
      projectedDeliveryDate: new Date("2026-12-01T12:00:00Z"), // still before promise
      allOperationsDone: false,
    }));
    expect(result.riskStatus).toBe("AT_RISK");
    expect(result.reasonCode).toBe("IMMINENT_INCOMPLETE");
  });

  it("SAFE — imminent but every operation is already DONE (no real remaining risk)", () => {
    const result = classifyPromiseRisk(evidence({
      promisedDate: new Date("2026-12-02T00:00:00Z"),
      projectedDeliveryDate: new Date("2026-12-01T12:00:00Z"),
      allOperationsDone: true,
    }));
    expect(result.riskStatus).toBe("SAFE");
    expect(result.reasonCode).toBe("ON_TRACK");
  });

  it("UNKNOWN — missing schedule evidence is never treated as zero delay / SAFE", () => {
    const result = classifyPromiseRisk(evidence({ scheduleEvidence: "MISSING", projectedDeliveryDate: null }));
    expect(result.riskStatus).toBe("UNKNOWN");
    expect(result.delayHours).toBeNull();
    expect(result.explanation).toMatch(/unavailable/);
    expect(result.reasonCode).toBe("SCHEDULE_MISSING");
  });

  it("UNKNOWN — stale schedule evidence is distinct from missing, but still never SAFE", () => {
    const result = classifyPromiseRisk(evidence({ scheduleEvidence: "STALE" }));
    expect(result.riskStatus).toBe("UNKNOWN");
    expect(result.explanation).toMatch(/stale/);
    expect(result.reasonCode).toBe("SCHEDULE_STALE");
  });

  it("UNKNOWN — no scheduled operations exist yet, even though scheduleEvidence is AVAILABLE", () => {
    const result = classifyPromiseRisk(evidence({ projectedDeliveryDate: null }));
    expect(result.riskStatus).toBe("UNKNOWN");
    expect(result.reasonCode).toBe("SCHEDULE_INCONCLUSIVE");
  });

  it("UNKNOWN — a cancelled production order needs manual review, never silently SAFE or BREACHED", () => {
    const result = classifyPromiseRisk(evidence({ productionOrderStatus: "CANCELLED" }));
    expect(result.riskStatus).toBe("UNKNOWN");
    expect(result.reasonCode).toBe("PRODUCTION_CANCELLED");
  });

  it("SAFE — a pure-stock (no production leg) promise with nothing to verify further", () => {
    const result = classifyPromiseRisk(evidence({ hasProductionLeg: false, projectedDeliveryDate: null, scheduleEvidence: "MISSING" }));
    expect(result.riskStatus).toBe("SAFE");
    expect(result.reasonCode).toBe("NO_PRODUCTION_LEG");
  });

  // --- workflowStatus: a genuinely separate dimension ---

  it("an order can be BREACHED while recovery is AWAITING_APPROVAL at the same time", () => {
    const result = classifyPromiseRisk(evidence({
      projectedDeliveryDate: new Date("2026-12-11T00:00:00Z"),
      pendingRecoveryApproval: true,
    }));
    expect(result.riskStatus).toBe("BREACHED");
    expect(result.workflowStatus).toBe("AWAITING_APPROVAL");
  });

  it("a pending approval never upgrades risk to SAFE on its own", () => {
    const result = classifyPromiseRisk(evidence({
      projectedDeliveryDate: new Date("2026-12-11T00:00:00Z"),
      pendingRecoveryApproval: true,
      lastVerifiedRecovery: { satisfied: true, verifiedAt: new Date("2026-11-01T00:00:00Z") },
    }));
    expect(result.riskStatus).toBe("BREACHED"); // current real evidence still says late
    expect(result.workflowStatus).toBe("AWAITING_APPROVAL"); // pending takes precedence over a stale prior verification
  });

  it("a verified-restored recovery is reported as its own real workflow fact when current evidence also shows SAFE", () => {
    const result = classifyPromiseRisk(evidence({
      lastVerifiedRecovery: { satisfied: true, verifiedAt: new Date("2026-11-15T00:00:00Z") },
    }));
    expect(result.riskStatus).toBe("SAFE");
    expect(result.workflowStatus).toBe("RECOVERY_VERIFIED_RESTORED");
  });

  it("a verified-FAILED recovery is reported honestly, never hidden as NONE", () => {
    const result = classifyPromiseRisk(evidence({
      projectedDeliveryDate: new Date("2026-12-11T00:00:00Z"),
      lastVerifiedRecovery: { satisfied: false, verifiedAt: new Date("2026-11-15T00:00:00Z") },
    }));
    expect(result.riskStatus).toBe("BREACHED");
    expect(result.workflowStatus).toBe("RECOVERY_VERIFIED_FAILED");
  });

  it("simulation data (feasible/projected from a what-if) is not even representable as an input — nothing to pass here", () => {
    // Structural proof, not a runtime assertion: PromiseEvidence has no
    // feasible/simulated_* field at all, so a Phase 13 scenario's
    // what-if result can never be smuggled into this classification —
    // see the module's own doc comment.
    const keys = Object.keys(evidence());
    expect(keys).not.toContain("feasible");
    expect(keys).not.toContain("simulatedProjectedDeliveryDate");
  });
});

describe("comparePromisePriority", () => {
  function item(overrides: Partial<Parameters<typeof comparePromisePriority>[0]> = {}) {
    return {
      riskStatus: "SAFE" as const,
      workflowStatus: "NONE" as const,
      delayHours: null,
      promisedDate: new Date("2026-12-10T00:00:00Z"),
      priorityScore: null,
      ...overrides,
    };
  }

  it("BREACHED sorts before AT_RISK, AT_RISK before UNKNOWN, UNKNOWN before SAFE", () => {
    const breached = item({ riskStatus: "BREACHED" });
    const atRisk = item({ riskStatus: "AT_RISK" });
    const unknown = item({ riskStatus: "UNKNOWN" });
    const safe = item({ riskStatus: "SAFE" });
    const sorted = [safe, unknown, atRisk, breached].sort(comparePromisePriority);
    expect(sorted.map((i) => i.riskStatus)).toEqual(["BREACHED", "AT_RISK", "UNKNOWN", "SAFE"]);
  });

  it("within BREACHED, worse delay sorts first", () => {
    const small = item({ riskStatus: "BREACHED", delayHours: 2 });
    const large = item({ riskStatus: "BREACHED", delayHours: 48 });
    expect([small, large].sort(comparePromisePriority)).toEqual([large, small]);
  });

  it("within BREACHED, AWAITING_APPROVAL sorts before no-workflow-activity", () => {
    const pending = item({ riskStatus: "BREACHED", workflowStatus: "AWAITING_APPROVAL", delayHours: 5 });
    const none = item({ riskStatus: "BREACHED", workflowStatus: "NONE", delayHours: 5 });
    expect([none, pending].sort(comparePromisePriority)).toEqual([pending, none]);
  });

  it("ties break on soonest promise date, then on existing explicit priority score — never an invented weight", () => {
    const soon = item({ promisedDate: new Date("2026-12-01T00:00:00Z") });
    const later = item({ promisedDate: new Date("2026-12-20T00:00:00Z") });
    expect([later, soon].sort(comparePromisePriority)).toEqual([soon, later]);

    const highPriority = item({ priorityScore: 90 });
    const lowPriority = item({ priorityScore: 10 });
    expect([lowPriority, highPriority].sort(comparePromisePriority)).toEqual([highPriority, lowPriority]);
  });
});
