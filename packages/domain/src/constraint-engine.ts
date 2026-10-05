// §7 Constraint Engine — invoked for every candidate (operation, machine,
// time-slot) triple. Each function below is one row from §7's table,
// independently testable, returning FEASIBLE or INFEASIBLE with a reason
// (and, where the doc specifies one, the earliest feasible alternative).
// Hard constraints must never be violated; soft constraints return a penalty
// cost instead of a pass/fail, consumed by the Optimization Engine (§9).

import { expandShiftWindows } from "./shift-expansion";

export type ConstraintResult =
  | { feasible: true }
  | { feasible: false; reason: string; earliestFeasibleStart?: Date };

export type TimeWindow = { start: Date; end: Date };

function overlaps(a: TimeWindow, b: TimeWindow): boolean {
  return a.start < b.end && b.start < a.end;
}

// 1. Machine Capacity (Hard)
// existing_load + op_time ≤ effective_capacity = shift_min × efficiency × availability
export function checkMachineCapacity(input: {
  existingLoadMin: number;
  opTimeMin: number;
  shiftMin: number;
  efficiencyFactor: number;
  availabilityFactor: number;
}): ConstraintResult {
  const effectiveCapacity = input.shiftMin * input.efficiencyFactor * input.availabilityFactor;
  if (input.existingLoadMin + input.opTimeMin <= effectiveCapacity) return { feasible: true };
  return { feasible: false, reason: "Machine capacity exceeded for this shift" };
}

// 2. Machine Downtime / Breakdown (Hard)
export function checkMachineDowntime(candidate: TimeWindow, downtimeWindows: TimeWindow[]): ConstraintResult {
  const blocking = downtimeWindows.find((w) => overlaps(candidate, w));
  if (!blocking) return { feasible: true };
  return { feasible: false, reason: "Overlaps a machine downtime window", earliestFeasibleStart: blocking.end };
}

// 3. Preventive Maintenance (Hard) — PM windows are BLOCKED reservations;
// ±2-day flexibility band means PM can slide within that band to avoid a
// conflict, so this only rejects when the PM window can't be moved clear.
export function checkPreventiveMaintenance(
  candidate: TimeWindow,
  pmWindows: TimeWindow[],
  flexibilityDays = 2
): ConstraintResult {
  for (const pm of pmWindows) {
    if (!overlaps(candidate, pm)) continue;
    const flexMs = flexibilityDays * 86_400_000;
    const earliestPmStart = new Date(pm.start.getTime() - flexMs);
    const latestPmEnd = new Date(pm.end.getTime() + flexMs);
    const stillConflicts = overlaps(candidate, { start: earliestPmStart, end: latestPmEnd });
    if (stillConflicts) {
      return { feasible: false, reason: "Overlaps preventive maintenance (outside flex band)", earliestFeasibleStart: latestPmEnd };
    }
  }
  return { feasible: true };
}

// 4. Operator Availability (Hard)
export function checkOperatorAvailability(qualifiedNonConflictingOperatorIds: string[]): ConstraintResult {
  if (qualifiedNonConflictingOperatorIds.length >= 1) return { feasible: true };
  return { feasible: false, reason: "No qualified, non-conflicting operator available" };
}

// 5. Operator Skills (Hard)
export function checkOperatorSkills(input: {
  operatorProficiency: "TRAINEE" | "STANDARD" | "EXPERT" | null;
  minProficiency: "TRAINEE" | "STANDARD" | "EXPERT";
  certificationExpiresAt: Date | null;
  now: Date;
}): ConstraintResult {
  const rank = { TRAINEE: 0, STANDARD: 1, EXPERT: 2 };
  if (input.operatorProficiency == null) return { feasible: false, reason: "Operator lacks required skill" };
  if (rank[input.operatorProficiency] < rank[input.minProficiency]) {
    return { feasible: false, reason: "Operator proficiency below required level" };
  }
  if (input.certificationExpiresAt && input.certificationExpiresAt < input.now) {
    return { feasible: false, reason: "Operator certification has expired" };
  }
  return { feasible: true };
}

// 6. Material Availability (Hard)
// qty_available = stock − prior_reservations + confirmed_inbound
export function checkMaterialAvailability(input: {
  stock: number;
  priorReservations: number;
  confirmedInbound: number;
  required: number;
}): ConstraintResult {
  const qtyAvailable = input.stock - input.priorReservations + input.confirmedInbound;
  if (qtyAvailable >= input.required) return { feasible: true };
  return { feasible: false, reason: `Material shortage: need ${input.required}, have ${qtyAvailable}` };
}

// 7. Tool Availability (Hard)
export function checkToolAvailability(input: {
  availableQty: number;
  requiredQty: number;
  remainingLifePct: number;
  minRequiredLifePct: number;
}): ConstraintResult {
  if (input.availableQty < input.requiredQty) {
    return { feasible: false, reason: "Insufficient tool quantity available" };
  }
  if (input.remainingLifePct < input.minRequiredLifePct) {
    return { feasible: false, reason: "Tool remaining life below required minimum" };
  }
  return { feasible: true };
}

// 8. Shift Calendar (Hard) — slot must fall entirely within active shift
// hours; no part may run during a break or non-shift time.
export function checkShiftCalendar(candidate: TimeWindow, activeShiftWindows: TimeWindow[]): ConstraintResult {
  const fitsEntirelyWithinOneShift = activeShiftWindows.some(
    (shift) => candidate.start >= shift.start && candidate.end <= shift.end
  );
  if (fitsEntirelyWithinOneShift) return { feasible: true };
  return { feasible: false, reason: "Slot falls outside active shift hours" };
}

// 9. Holiday Calendar (Hard)
export function checkHolidayCalendar(candidate: TimeWindow, holidayDates: Date[]): ConstraintResult {
  const isoHolidays = new Set(holidayDates.map((h) => h.toISOString().slice(0, 10)));
  const candidateDates: Date[] = [];
  // Exclusive end + UTC-consistent stepping: the original inclusive `d <=
  // candidate.end` (combined with local-time `setDate`) meant a window
  // ending exactly at midnight also counted the NEXT calendar day as part
  // of the candidate — a real bug that made a window merely adjacent to a
  // holiday get wrongly rejected as if it fell ON the holiday.
  for (let t = candidate.start.getTime(); t < candidate.end.getTime(); t += 86_400_000) {
    candidateDates.push(new Date(t));
  }
  if (candidateDates.length === 0) candidateDates.push(candidate.start);
  const hitsHoliday = candidateDates.some((d) => isoHolidays.has(d.toISOString().slice(0, 10)));
  if (!hitsHoliday) return { feasible: true };
  return { feasible: false, reason: "Slot falls on a declared holiday or factory shutdown day" };
}

// 10. QC Hold (Hard)
export function checkQcHold(predecessorRequiresInspection: boolean, predecessorQcResult: "PASS" | "FAIL" | "PENDING" | null): ConstraintResult {
  if (!predecessorRequiresInspection) return { feasible: true };
  if (predecessorQcResult === "PASS") return { feasible: true };
  return { feasible: false, reason: "Predecessor operation is on QC hold" };
}

// 11. Batch Size (Hard min / Soft max)
export type BatchSizeResult =
  | { action: "PROCEED" }
  | { action: "AGGREGATE_WITH_ANOTHER_ORDER"; reason: string }
  | { action: "SPLIT_INTO_SUBBATCHES"; subBatchCount: number };

export function checkBatchSize(qty: number, minBatch: number, maxBatch: number | null): BatchSizeResult {
  if (qty < minBatch) {
    return { action: "AGGREGATE_WITH_ANOTHER_ORDER", reason: `Qty ${qty} below min batch ${minBatch}` };
  }
  if (maxBatch != null && qty > maxBatch) {
    return { action: "SPLIT_INTO_SUBBATCHES", subBatchCount: Math.ceil(qty / maxBatch) };
  }
  return { action: "PROCEED" };
}

// 12. Machine Capability (Hard)
export function checkMachineCapability(capabilities: { operationType: string; spec?: unknown }[], requiredOperationType: string): ConstraintResult {
  const has = capabilities.some((c) => c.operationType === requiredOperationType);
  if (has) return { feasible: true };
  return { feasible: false, reason: `Machine has no capability record for operation type "${requiredOperationType}"` };
}

// 13. Alternative Machines (Resolution) — not a pass/fail check itself;
// walks a priority-ordered list of alternatives and returns the first one a
// caller-supplied feasibility check accepts.
export function resolveAlternativeMachine<M>(
  alternativesInPriorityOrder: M[],
  isFeasible: (machine: M) => boolean
): M | null {
  return alternativesInPriorityOrder.find(isFeasible) ?? null;
}

// 14. Delivery Deadline (Hard SLA)
export function checkDeliveryDeadline(scheduledEnd: Date, dueDate: Date): ConstraintResult {
  if (scheduledEnd <= dueDate) return { feasible: true };
  return { feasible: false, reason: "Scheduled completion exceeds the delivery deadline — escalate for overtime/alternative machine" };
}

// 15. Power Consumption (Soft) — returns a penalty rather than infeasible;
// consumed by the Optimization Engine's W6×SoftViolations term (§9).
export function checkPowerConsumption(concurrentPowerKw: number, plantMaxPowerKw: number): { withinLimit: boolean; excessKw: number } {
  const excessKw = Math.max(0, concurrentPowerKw - plantMaxPowerKw);
  return { withinLimit: excessKw === 0, excessKw };
}

// 16. Business / Plant Rules (Configurable) — a small rule-evaluator rather
// than a bespoke DSL/parser (disproportionate for one config surface); each
// rule is a plain predicate function registered per plant.
export type PlantRule<TContext> = { name: string; evaluate: (ctx: TContext) => ConstraintResult };

export function checkPlantRules<TContext>(rules: PlantRule<TContext>[], ctx: TContext): ConstraintResult {
  for (const rule of rules) {
    const result = rule.evaluate(ctx);
    if (result.feasible === false) return { feasible: false, reason: `[${rule.name}] ${result.reason}` };
  }
  return { feasible: true };
}

// Moved here (Phase 2, real practical-capacity reporting) from
// scheduling-service/src/pipeline.ts, where these were module-private —
// pure extraction, identical bodies, no behavior change to real placement.
// Exporting them lets the Workload graph's real shift/holiday-adjusted
// capacity computation reuse the EXACT same narrowing semantics the live
// pipeline places operations with, instead of risking a second,
// silently-diverging copy of this logic.

// §7 Shift Calendar (Hard): a work center with zero configured Shift rows
// (true for every plant as of this writing, since nothing populated them
// before now) must NOT be restricted — checkShiftCalendar's .some() over an
// empty activeShiftWindows array returns infeasible unconditionally, which
// would make every operation on every unconfigured work center unplaceable.
// Only narrow when shifts are actually configured.
export function narrowWindowsToShifts(
  windows: TimeWindow[],
  shifts: { startTime: string; endTime: string; daysOfWeek: number[] }[],
  searchStart: Date,
  searchEnd: Date,
  durationMin: number
): TimeWindow[] {
  if (shifts.length === 0) return windows;

  const shiftWindows = expandShiftWindows(shifts, searchStart, searchEnd);
  const narrowed: TimeWindow[] = [];
  for (const w of windows) {
    for (const shift of shiftWindows) {
      const start = new Date(Math.max(w.start.getTime(), shift.start.getTime()));
      const end = new Date(Math.min(w.end.getTime(), shift.end.getTime()));
      if (end.getTime() - start.getTime() < durationMin * 60_000) continue;
      const candidate = { start, end };
      if (checkShiftCalendar(candidate, shiftWindows).feasible) narrowed.push(candidate);
    }
  }
  return narrowed.sort((a, b) => a.start.getTime() - b.start.getTime());
}

// §7 Holiday Calendar (Hard), applied only when the plant has at least one
// FactoryCalendarDay marked as a holiday/non-working day — same additive
// guard as every other optional constraint here (a plant with no calendar
// imported schedules exactly as before). Walks each window day by day
// (using the real checkHolidayCalendar check per day) and splits OUT just
// the holiday days rather than discarding the whole window, so a holiday
// in the middle of an otherwise-open multi-day window doesn't wrongly
// throw away the open days on either side of it.
export function narrowWindowsToHolidays(
  windows: TimeWindow[],
  holidayDates: Date[],
  workingDaysOfWeek: number[] | null,
  minDurationMin: number
): TimeWindow[] {
  if (holidayDates.length === 0 && workingDaysOfWeek === null) return windows;
  const result: TimeWindow[] = [];
  for (const w of windows) {
    let segStart: Date | null = w.start;
    const cursor = new Date(w.start);
    cursor.setUTCHours(0, 0, 0, 0);
    while (cursor.getTime() < w.end.getTime()) {
      const dayEnd = new Date(cursor.getTime() + 86_400_000);
      const overlapStart = new Date(Math.max(cursor.getTime(), w.start.getTime()));
      const overlapEnd = new Date(Math.min(dayEnd.getTime(), w.end.getTime()));
      const isOffWeek = workingDaysOfWeek !== null && !workingDaysOfWeek.includes(cursor.getUTCDay());
      const isHoliday = isOffWeek || !checkHolidayCalendar({ start: overlapStart, end: overlapEnd }, holidayDates).feasible;
      if (isHoliday) {
        if (segStart != null && overlapStart.getTime() > segStart.getTime()) {
          result.push({ start: segStart, end: overlapStart });
        }
        segStart = null;
      } else if (segStart == null) {
        segStart = overlapStart;
      }
      cursor.setTime(dayEnd.getTime());
    }
    if (segStart != null && segStart.getTime() < w.end.getTime()) {
      result.push({ start: segStart, end: w.end });
    }
  }
  return result.filter((s) => s.end.getTime() - s.start.getTime() >= minDurationMin * 60_000);
}
