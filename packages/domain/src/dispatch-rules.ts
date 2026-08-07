// §6 Dispatch Rules — configurable per Work Centre, used to order a set of
// waiting operations competing for the same work centre.
export type DispatchRuleName = "EDD" | "SPT" | "LPT" | "CR" | "ATCS" | "PRIORITY_SCORE";

export type DispatchCandidate = {
  id: string;
  dueDate: Date;
  processingTimeMin: number;
  setupTimeMin: number;
  priorityScore: number;
};

function criticalRatio(candidate: DispatchCandidate, now: Date): number {
  const remainingTimeMin = candidate.processingTimeMin + candidate.setupTimeMin;
  const dueDateMinutes = (candidate.dueDate.getTime() - now.getTime()) / 60_000;
  // Guard against divide-by-zero for a zero-duration operation; treat it as
  // "already as tight as possible" rather than throwing.
  return remainingTimeMin <= 0 ? Infinity : dueDateMinutes / remainingTimeMin;
}

// ATCS = Apparent Tardiness Cost with Setups: urgency × exp(−setup_cost).
// "Urgency" isn't pinned to one exact formula in the doc; using 1/CR is the
// standard ATCS urgency term (higher when due date is closer relative to
// remaining work), which is what makes "Sequence-dependent setup
// environments (default)" — heavier setup lowers a job's effective urgency.
function atcsScore(candidate: DispatchCandidate, now: Date): number {
  const cr = criticalRatio(candidate, now);
  const urgency = cr === Infinity ? 0 : 1 / Math.max(cr, 0.001);
  return urgency * Math.exp(-candidate.setupTimeMin / 60);
}

export function sortByDispatchRule(
  candidates: DispatchCandidate[],
  rule: DispatchRuleName,
  now: Date = new Date()
): DispatchCandidate[] {
  const sorted = [...candidates];
  switch (rule) {
    case "EDD":
      return sorted.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
    case "SPT":
      return sorted.sort((a, b) => a.processingTimeMin - b.processingTimeMin);
    case "LPT":
      return sorted.sort((a, b) => b.processingTimeMin - a.processingTimeMin);
    case "CR":
      return sorted.sort((a, b) => criticalRatio(a, now) - criticalRatio(b, now));
    case "ATCS":
      return sorted.sort((a, b) => atcsScore(b, now) - atcsScore(a, now));
    case "PRIORITY_SCORE":
      return sorted.sort((a, b) => b.priorityScore - a.priorityScore);
  }
}
