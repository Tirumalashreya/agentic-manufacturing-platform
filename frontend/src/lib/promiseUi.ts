import type { StatusTone } from "@/components/ui";

// Phase 12 — pure, framework-free helpers shared by ScenarioComparison and
// RecommendationCard. Kept separate from the components themselves so
// they're trivially unit-testable with no React rendering involved, and
// so there is exactly one place that decides what each backend value
// means — never two components independently reinterpreting the same
// `feasible` field and risking drifting apart.
//
// feasible is a real three-state value (see PromiseScenario's own doc
// comment in types/workflow.ts): true/false come from a real
// deterministic simulation; null means no non-committing simulation
// exists for this action at all — its real outcome is only knowable by
// executing it. This function is the ONE place that distinction is
// translated into UI text; it must never collapse null into either
// "Feasible" or "Infeasible".
export function feasibilityLabel(feasible: boolean | null): { text: string; tone: StatusTone } {
  if (feasible === true) return { text: "Feasible", tone: "success" };
  if (feasible === false) return { text: "Not feasible", tone: "danger" };
  return { text: "Outcome unknown until execution", tone: "neutral" };
}

// Phase 13 — deliberately a DIFFERENT fact from feasibilityLabel above: a
// reschedule can be feasible (the scheduler placed every operation
// somewhere) while still landing after the original promise date.
// undefined/null both mean "no original promise applies to this
// scenario" (e.g. a fresh ORDER_PROMISE request) — returns null so the
// caller renders nothing, rather than a misleading "not restored."
export function promiseRestoredLabel(promiseRestored: boolean | null | undefined): { text: string; tone: StatusTone } | null {
  if (promiseRestored === true) return { text: "Promise restored", tone: "success" };
  if (promiseRestored === false) return { text: "Promise not restored", tone: "danger" };
  return null;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  // A plain calendar date (YYYY-MM-DD, what the backend actually sends
  // for requested/projected delivery dates) is reformatted directly, not
  // through `new Date(...)` — parsing a date-only string as UTC and then
  // rendering it in the viewer's local timezone can shift it a day
  // backward for anyone west of UTC, which would misreport a real
  // promise date. Only a real timestamp (has a time component) goes
  // through Date/toLocaleString.
  const dateOnlyMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    return `${month}/${day}/${year}`;
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}
