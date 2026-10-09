// Phase 14 (Promise Risk & Decision Inbox) — the one centralized,
// deterministic, unit-tested function that decides whether a customer
// promise is at risk. No LLM anywhere in this file (the architecture
// contract's own no_llm_outside_agent_orchestrator check — adapted in
// spirit here even though this package isn't scheduling-service —
// applies the same principle: risk is calculated, never reasoned about).
//
// Two independent dimensions, deliberately never merged into one field:
//   - riskStatus: BREACHED/AT_RISK/SAFE/UNKNOWN — purely a function of the
//     REAL current schedule evidence (ScheduledOperation/ProductionException/
//     QC holds). A Phase 10/13 simulation's feasible/projected_delivery_date
//     is NEVER an input here — simulation is not execution, and this
//     function has no way to even see one.
//   - workflowStatus: NONE/AWAITING_APPROVAL/RECOVERY_VERIFIED_RESTORED/
//     RECOVERY_VERIFIED_FAILED — purely a function of the approval/
//     execution trail (AgentPipelineRun). An order can be BREACHED and
//     AWAITING_APPROVAL at the same time; a pending approval never
//     upgrades riskStatus on its own, and only a real post-execution
//     goal_satisfaction check (never a pre-approval recommendation) can
//     ever set RECOVERY_VERIFIED_*.

export type PromiseRiskStatus = "BREACHED" | "AT_RISK" | "SAFE" | "UNKNOWN";
export type PromiseWorkflowStatus = "NONE" | "AWAITING_APPROVAL" | "RECOVERY_VERIFIED_RESTORED" | "RECOVERY_VERIFIED_FAILED";

// Named, documented constant (brief: "do not invent... arbitrary risk
// weights") — the one threshold this module uses, given a name and a
// single definition rather than a buried magic number repeated anywhere
// it's checked. Matches the brief's own example ("delivery is due
// tomorrow") taken as "within two days," a deliberately round, stated
// choice, not tuned/fitted to any data.
export const AT_RISK_WINDOW_HOURS = 48;

export type PromiseEvidence = {
  promisedDate: Date;
  // Whether the production side has anything to actually check at all —
  // a line with no production leg at all (pure MTS, fully from stock)
  // has nothing more to verify once created; evidence is "AVAILABLE" with
  // no further scheduling signal needed and is treated as SAFE as long as
  // nothing else disputes it.
  hasProductionLeg: boolean;
  productionOrderStatus: string | null;
  // "MISSING" — expected schedule data could not be read at all (the
  // production order doesn't exist, or has zero ScheduledOperation rows
  // despite being RELEASED/PLANNED). "STALE" — the caller's own freshness
  // check (e.g. a read that is known to be from a cached/older snapshot)
  // found the data too old to trust. "AVAILABLE" — real, current data.
  scheduleEvidence: "AVAILABLE" | "MISSING" | "STALE";
  projectedDeliveryDate: Date | null;
  allOperationsDone: boolean;
  openExceptionCount: number;
  // Real, already-persisted signal — true when any ScheduledOperation for
  // this production order has status === "BLOCKED" (the existing
  // Block/Resume mechanism, which already covers both a QC hold and a
  // manual block — see ScheduledOpStatus). Not re-derived from
  // checkQcHold's own dependency-graph logic, which answers a narrower,
  // execution-time question (can THIS NEXT operation start); this reuses
  // the real, already-committed status instead of recomputing it.
  hasOpenQcHold: boolean;
  pendingRecoveryApproval: boolean;
  lastVerifiedRecovery: { satisfied: boolean; verifiedAt: Date } | null;
  now: Date;
};

// Phase 15 (Promise Intelligence & Evidence Quality) — a short, stable,
// machine-readable code alongside the human-readable `explanation`, one
// per classification branch below. Added because the brief names this
// explicitly ("risk category and deterministic reason codes") and the
// prior implementation only had free text — a caller that wants to group,
// filter, or localize by reason had nothing stable to key on. Purely
// additive: every existing consumer of `explanation`/`riskStatus` is
// unaffected.
export type PromiseRiskReasonCode =
  | "NO_PRODUCTION_LEG"
  | "SCHEDULE_MISSING"
  | "SCHEDULE_STALE"
  | "PRODUCTION_CANCELLED"
  | "SCHEDULE_INCONCLUSIVE"
  | "SCHEDULE_OVERRUN"
  | "OPEN_PRODUCTION_EXCEPTION"
  | "QUALITY_HOLD"
  | "IMMINENT_INCOMPLETE"
  | "ON_TRACK";

export type PromiseRiskResult = {
  riskStatus: PromiseRiskStatus;
  workflowStatus: PromiseWorkflowStatus;
  explanation: string;
  reasonCode: PromiseRiskReasonCode;
  // Only meaningful (non-null) once a real projectedDeliveryDate exists
  // AND it is after promisedDate — never fabricated for an UNKNOWN/SAFE
  // case, and never negative (a promise met early is not "negative delay").
  delayHours: number | null;
};

function formatDelay(hours: number): string {
  if (hours < 24) return `${Math.round(hours)} hour(s)`;
  const days = hours / 24;
  return `${days % 1 === 0 ? days : days.toFixed(1)} day(s)`;
}

export function classifyPromiseRisk(evidence: PromiseEvidence): PromiseRiskResult {
  const workflowStatus: PromiseWorkflowStatus = evidence.pendingRecoveryApproval
    ? "AWAITING_APPROVAL"
    : evidence.lastVerifiedRecovery
    ? evidence.lastVerifiedRecovery.satisfied
      ? "RECOVERY_VERIFIED_RESTORED"
      : "RECOVERY_VERIFIED_FAILED"
    : "NONE";

  // Risk classification below is deliberately computed independently of
  // workflowStatus — a pending or even a verified-restored recovery does
  // NOT retroactively change what the CURRENT real schedule evidence
  // says. If the current projection is still late, it is still BREACHED,
  // whatever the workflow trail says (brief: "a pending approval does
  // not mean recovery is complete").

  if (!evidence.hasProductionLeg) {
    return {
      riskStatus: "SAFE",
      workflowStatus,
      explanation: "This promise has no production leg to verify (fulfilled entirely from stock).",
      reasonCode: "NO_PRODUCTION_LEG",
      delayHours: null,
    };
  }

  if (evidence.scheduleEvidence === "MISSING") {
    return {
      riskStatus: "UNKNOWN",
      workflowStatus,
      explanation: "Schedule evidence is unavailable; investigate before treating this promise as safe.",
      reasonCode: "SCHEDULE_MISSING",
      delayHours: null,
    };
  }
  if (evidence.scheduleEvidence === "STALE") {
    return {
      riskStatus: "UNKNOWN",
      workflowStatus,
      explanation: "Schedule evidence is stale; investigate before treating this promise as safe.",
      reasonCode: "SCHEDULE_STALE",
      delayHours: null,
    };
  }
  if (evidence.productionOrderStatus === "CANCELLED") {
    return {
      riskStatus: "UNKNOWN",
      workflowStatus,
      explanation: "The linked production order was cancelled; this promise needs manual review.",
      reasonCode: "PRODUCTION_CANCELLED",
      delayHours: null,
    };
  }
  if (evidence.projectedDeliveryDate === null) {
    return {
      riskStatus: "UNKNOWN",
      workflowStatus,
      explanation: "No scheduled operations exist yet for this order's production; investigate before treating this promise as safe.",
      reasonCode: "SCHEDULE_INCONCLUSIVE",
      delayHours: null,
    };
  }

  if (evidence.projectedDeliveryDate.getTime() > evidence.promisedDate.getTime()) {
    const delayHours = (evidence.projectedDeliveryDate.getTime() - evidence.promisedDate.getTime()) / 3_600_000;
    return {
      riskStatus: "BREACHED",
      workflowStatus,
      explanation: `Projected delivery is ${formatDelay(delayHours)} after the committed promise.`,
      reasonCode: "SCHEDULE_OVERRUN",
      delayHours,
    };
  }

  if (evidence.openExceptionCount > 0) {
    return {
      riskStatus: "AT_RISK",
      workflowStatus,
      explanation: `${evidence.openExceptionCount} unresolved production exception(s) affect this order.`,
      reasonCode: "OPEN_PRODUCTION_EXCEPTION",
      delayHours: null,
    };
  }
  if (evidence.hasOpenQcHold) {
    return {
      riskStatus: "AT_RISK",
      workflowStatus,
      explanation: "A quality hold is currently blocking this order's production.",
      reasonCode: "QUALITY_HOLD",
      delayHours: null,
    };
  }
  const hoursUntilPromise = (evidence.promisedDate.getTime() - evidence.now.getTime()) / 3_600_000;
  if (!evidence.allOperationsDone && hoursUntilPromise <= AT_RISK_WINDOW_HOURS) {
    return {
      riskStatus: "AT_RISK",
      workflowStatus,
      explanation: `Delivery is due within ${AT_RISK_WINDOW_HOURS} hours and production is not yet complete.`,
      reasonCode: "IMMINENT_INCOMPLETE",
      delayHours: null,
    };
  }

  return {
    riskStatus: "SAFE",
    workflowStatus,
    explanation: "Current schedule evidence supports meeting the promise.",
    reasonCode: "ON_TRACK",
    delayHours: null,
  };
}

// Phase 14 §5 (Deterministic Prioritization) — a pure comparator, no
// invented customer-value/severity weights. Groups by riskStatus in the
// brief's own stated order, then breaks ties within BREACHED/AT_RISK by
// delayHours (worse first) or time-to-promise (soonest first), and
// everywhere else by promisedDate (soonest first) — all real, already-
// available signals, nothing synthesized.
const GROUP_ORDER: Record<PromiseRiskStatus, number> = { BREACHED: 0, AT_RISK: 1, SAFE: 3, UNKNOWN: 2 };
// Within the AT_RISK/UNKNOWN bands, an item already awaiting a human
// decision is surfaced before one that still only needs investigation —
// matches the brief's own groupings (3. other at-risk, 4. awaiting
// approval, 5. unknown/stale) without inventing a parallel weight.
const WORKFLOW_ORDER: Record<PromiseWorkflowStatus, number> = {
  AWAITING_APPROVAL: 0, RECOVERY_VERIFIED_FAILED: 1, NONE: 2, RECOVERY_VERIFIED_RESTORED: 3,
};

export type PrioritizablePromise = {
  riskStatus: PromiseRiskStatus;
  workflowStatus: PromiseWorkflowStatus;
  delayHours: number | null;
  promisedDate: Date;
  priorityScore: number | null; // the order's own existing, already-computed priority score, if available
};

export function comparePromisePriority(a: PrioritizablePromise, b: PrioritizablePromise): number {
  const groupDiff = GROUP_ORDER[a.riskStatus] - GROUP_ORDER[b.riskStatus];
  if (groupDiff !== 0) return groupDiff;

  if (a.riskStatus === "BREACHED" || a.riskStatus === "AT_RISK") {
    const workflowDiff = WORKFLOW_ORDER[a.workflowStatus] - WORKFLOW_ORDER[b.workflowStatus];
    if (workflowDiff !== 0) return workflowDiff;
    if (a.delayHours !== null && b.delayHours !== null && a.delayHours !== b.delayHours) {
      return b.delayHours - a.delayHours; // worse delay first
    }
  }

  const promiseDiff = a.promisedDate.getTime() - b.promisedDate.getTime(); // soonest first
  if (promiseDiff !== 0) return promiseDiff;

  const scoreA = a.priorityScore ?? 0;
  const scoreB = b.priorityScore ?? 0;
  return scoreB - scoreA; // existing explicit order priority, higher first
}
