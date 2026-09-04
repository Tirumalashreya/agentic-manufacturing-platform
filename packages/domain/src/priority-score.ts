// §6 Priority Score Formula:
//   Score = 0.25×CustomerTier + 0.30×DueDateUrgency + 0.15×OrderValue
//         + 0.20×PenaltyRisk + 0.05×CriticalPath + 0.05×ManualOverride
//
// The doc gives exact formulas for CustomerTier and DueDateUrgency but not
// for OrderValue/PenaltyRisk normalization — both are implemented here as
// "score out of 100 relative to a reference maximum", the same shape as
// CustomerTier/DueDateUrgency, and documented explicitly since that's an
// interpretation rather than a literal transcription of the doc.
import type { CustomerTier } from "../src/generated/prisma/enums";
export type { CustomerTier };

const CUSTOMER_TIER_SCORE: Record<CustomerTier, number> = {
  PLATINUM: 100,
  GOLD: 75,
  SILVER: 50,
  STANDARD: 25,
};

export type PriorityScoreWeights = {
  customerTier: number;
  dueDateUrgency: number;
  orderValue: number;
  penaltyRisk: number;
  criticalPath: number;
  manualOverride: number;
};

// "All weights configurable per plant via YAML" — substituted with a plain
// per-plant config object (no YAML parser pulled in for one settings blob);
// these are the doc's own defaults.
export const DEFAULT_WEIGHTS: PriorityScoreWeights = {
  customerTier: 0.25,
  dueDateUrgency: 0.3,
  orderValue: 0.15,
  penaltyRisk: 0.2,
  criticalPath: 0.05,
  manualOverride: 0.05,
};

export type PriorityScoreInput = {
  customerTier: CustomerTier;
  dueDate: Date;
  now: Date;
  planningHorizonDays: number;
  orderValue: number;
  referenceMaxOrderValue: number;
  penaltyPerDay: number;
  slaDays: number;
  referenceMaxPenaltyExposure: number;
  /** 0 (not on critical path) .. 1 (float = 0, per §6 step 4 EST/EFT/LST/LFT pass) */
  criticalPathFactor?: number;
  /** 0..100, planner-set */
  manualOverride?: number;
  weights?: PriorityScoreWeights;
};

function clamp0to100(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function computeDueDateUrgency(dueDate: Date, now: Date, planningHorizonDays: number): number {
  const daysRemaining = (dueDate.getTime() - now.getTime()) / 86_400_000;
  return clamp0to100(100 * (1 - daysRemaining / planningHorizonDays));
}

export function computePriorityScore(input: PriorityScoreInput): number {
  const weights = input.weights ?? DEFAULT_WEIGHTS;

  const customerTierScore = CUSTOMER_TIER_SCORE[input.customerTier];
  const dueDateUrgencyScore = computeDueDateUrgency(input.dueDate, input.now, input.planningHorizonDays);
  const orderValueScore = clamp0to100((input.orderValue / input.referenceMaxOrderValue) * 100);
  const penaltyExposure = input.penaltyPerDay * input.slaDays;
  const penaltyRiskScore = clamp0to100((penaltyExposure / input.referenceMaxPenaltyExposure) * 100);
  const criticalPathScore = clamp0to100((input.criticalPathFactor ?? 0) * 100);
  const manualOverrideScore = clamp0to100(input.manualOverride ?? 0);

  return (
    weights.customerTier * customerTierScore +
    weights.dueDateUrgency * dueDateUrgencyScore +
    weights.orderValue * orderValueScore +
    weights.penaltyRisk * penaltyRiskScore +
    weights.criticalPath * criticalPathScore +
    weights.manualOverride * manualOverrideScore
  );
}
