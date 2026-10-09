// Stage 05 (§4 Independent Feasibility Validator) — a genuinely separate
// pass that re-derives feasibility from the real, already-persisted
// ScheduledOperation/ResourceReservation rows, never from pipeline.ts's own
// in-memory placement decisions. Reuses the same deterministic domain rule
// functions (@aps/domain's constraint-engine) the placement loop itself
// calls — reusing a proven rule ("does this machine have this capability")
// is not the same as trusting the scheduler's own conclusion that a
// specific placement satisfied it; this asks the question again, fresh,
// against what actually landed in Postgres.
//
// Called once, after a run's placements are all written (tagged with the
// new candidate scheduleVersionId) but BEFORE that candidate is published
// — see runSchedulingPipeline's Step 11. A rejection here means the
// candidate never goes live; the plant's previous PUBLISHED schedule is
// untouched and remains active.
import { prisma, checkMachineCapability, checkOperatorSkills, checkShiftCalendar, checkHolidayCalendar, type TimeWindow } from "@aps/domain";

export type ValidationResult = { valid: boolean; violations: string[] };

function overlaps(a: TimeWindow, b: TimeWindow): boolean {
  return a.start < b.end && b.start < a.end;
}

export async function validateScheduleFeasibility(plantId: string): Promise<ValidationResult> {
  const violations: string[] = [];

  // The real, currently-active set for this plant — carried-forward
  // protected operations from the previous version plus everything this
  // run just placed, exactly as it will be read by every other consumer
  // once published. supersededAt: null is the one and only definition of
  // "active" (see ScheduledOperation's Stage 05 schema comment).
  const activeOps = await prisma.scheduledOperation.findMany({
    where: { supersededAt: null, productionOrder: { plantId } },
    include: {
      productionOrder: { select: { id: true } },
      routingOperation: {
        select: {
          id: true,
          operation: true,
          requiredSkillId: true,
          minProficiency: true,
          predecessors: { select: { predecessorId: true } },
          workCenter: {
            select: {
              id: true,
              workingDaysOfWeek: true,
              shifts: { select: { shift: { select: { startTime: true, endTime: true, daysOfWeek: true } } } },
              holidayCalendar: { select: { holidays: { select: { day: true, month: true, year: true } } } },
            },
          },
        },
      },
      machine: { select: { id: true, capabilities: { select: { operationType: true } } } },
      operator: { select: { id: true, skills: { select: { skillId: true, proficiency: true, certifiedUntil: true } } } },
      reservations: { select: { state: true, machineId: true, operatorId: true, startTime: true, endTime: true } },
    },
  });

  if (activeOps.length === 0) return { valid: true, violations: [] };

  // --- 1. Precedence: for every operation with routing predecessors, every
  // predecessor that is ALSO in the active set for the same order must end
  // at or before this operation starts. A predecessor with no active row
  // (not yet scheduled, or belongs to a different, unscheduled run) can't
  // be checked and is honestly skipped rather than assumed either way.
  const activeByRoutingOp = new Map<string, (typeof activeOps)[number]>();
  for (const op of activeOps) {
    if (op.routingOperationId) activeByRoutingOp.set(`${op.productionOrderId}:${op.routingOperationId}`, op);
  }
  for (const op of activeOps) {
    for (const pred of op.routingOperation?.predecessors ?? []) {
      const predOp = activeByRoutingOp.get(`${op.productionOrderId}:${pred.predecessorId}`);
      if (predOp && predOp.scheduledEnd > op.scheduledStart) {
        violations.push(
          `Precedence violated: operation ${op.id} (order ${op.productionOrderId}) starts ${op.scheduledStart.toISOString()} ` +
            `before its predecessor ${predOp.id} ends ${predOp.scheduledEnd.toISOString()}`
        );
      }
    }
  }

  // --- 2. Overlap: independently re-derived from ScheduledOperation's own
  // timing, not from trusting the GiST exclusion constraint on
  // ResourceReservation (which only ever catches the write that happened
  // to still be COMMITTED at the moment of a conflicting insert, and isn't
  // itself exercised at all for operator-less/machine-less rows). Checked
  // pairwise per machine/operator across the whole active set.
  const byMachine = new Map<string, { id: string; start: Date; end: Date }[]>();
  const byOperator = new Map<string, { id: string; start: Date; end: Date }[]>();
  for (const op of activeOps) {
    const window = { id: op.id, start: op.scheduledStart, end: op.scheduledEnd };
    if (op.machineId) byMachine.set(op.machineId, [...(byMachine.get(op.machineId) ?? []), window]);
    if (op.operatorId) byOperator.set(op.operatorId, [...(byOperator.get(op.operatorId) ?? []), window]);
  }
  function checkNoOverlap(groups: Map<string, { id: string; start: Date; end: Date }[]>, resourceKind: string) {
    for (const [resourceId, windows] of groups) {
      for (let i = 0; i < windows.length; i++) {
        for (let j = i + 1; j < windows.length; j++) {
          if (overlaps(windows[i], windows[j])) {
            violations.push(
              `${resourceKind} ${resourceId} double-booked: operations ${windows[i].id} and ${windows[j].id} overlap`
            );
          }
        }
      }
    }
  }
  checkNoOverlap(byMachine, "Machine");
  checkNoOverlap(byOperator, "Operator");

  // --- 3. Machine eligibility + 4. Operator skill + 5. Shift/calendar
  // boundaries — re-checked per operation against the real master data,
  // using the exact same deterministic rule functions the placement loop
  // itself calls (constraint-engine.ts), applied here independently
  // against the committed result rather than a live candidate.
  const now = new Date();
  for (const op of activeOps) {
    const operationType = op.routingOperation?.operation;
    if (op.machine && operationType) {
      const capability = checkMachineCapability(op.machine.capabilities, operationType);
      if (capability.feasible === false) {
        violations.push(`Machine eligibility violated: operation ${op.id} placed on machine ${op.machine.id}, which ${capability.reason}`);
      }
    }

    if (op.operator && op.routingOperation?.requiredSkillId) {
      const skill = op.operator.skills.find((s) => s.skillId === op.routingOperation!.requiredSkillId);
      const skillCheck = checkOperatorSkills({
        operatorProficiency: (skill?.proficiency as "TRAINEE" | "STANDARD" | "EXPERT" | undefined) ?? null,
        minProficiency: (op.routingOperation.minProficiency as "TRAINEE" | "STANDARD" | "EXPERT" | null) ?? "TRAINEE",
        certificationExpiresAt: skill?.certifiedUntil ?? null,
        now,
      });
      if (skillCheck.feasible === false) {
        violations.push(`Operator skill violated: operation ${op.id} assigned to operator ${op.operator.id}, who ${skillCheck.reason}`);
      }
    }

    const workCenter = op.routingOperation?.workCenter;
    if (workCenter) {
      const window: TimeWindow = { start: op.scheduledStart, end: op.scheduledEnd };
      const shiftRows = workCenter.shifts.map((s) => s.shift);
      if (shiftRows.length > 0) {
        const shiftWindows = expandShiftWindowsForDay(shiftRows, op.scheduledStart, op.scheduledEnd);
        const shiftCheck = checkShiftCalendar(window, shiftWindows);
        if (shiftCheck.feasible === false) {
          violations.push(`Shift boundary violated: operation ${op.id} (${shiftCheck.reason}) on work center ${workCenter.id}`);
        }
      }
      const holidayDates = (workCenter.holidayCalendar?.holidays ?? []).map((h) => new Date(Date.UTC(h.year, h.month - 1, h.day)));
      if (holidayDates.length > 0) {
        const holidayCheck = checkHolidayCalendar(window, holidayDates);
        if (holidayCheck.feasible === false) {
          violations.push(`Calendar boundary violated: operation ${op.id} (${holidayCheck.reason}) on work center ${workCenter.id}`);
        }
      }
      if (workCenter.workingDaysOfWeek.length > 0) {
        const startDay = op.scheduledStart.getUTCDay();
        if (!workCenter.workingDaysOfWeek.includes(startDay)) {
          violations.push(`Calendar boundary violated: operation ${op.id} starts on a non-working day of week (${startDay}) for work center ${workCenter.id}`);
        }
      }
    }

    // --- 6. Reservation conflicts: every active, machine-assigned
    // operation must have a matching COMMITTED reservation with the exact
    // same window — a ghost placement (row exists, no backing reservation)
    // or a drifted one (reservation time disagrees with the operation) is
    // exactly the kind of inconsistency the GiST constraint alone can't
    // catch, since that constraint only ever compares reservations against
    // each other, never against the ScheduledOperation row they're meant
    // to back.
    if (op.machineId) {
      const backing = op.reservations.find(
        (r) => r.state === "COMMITTED" && r.machineId === op.machineId &&
          r.startTime.getTime() === op.scheduledStart.getTime() && r.endTime.getTime() === op.scheduledEnd.getTime()
      );
      if (!backing) {
        violations.push(`Reservation conflict: active operation ${op.id} has no matching COMMITTED machine reservation`);
      }
    }
  }

  // --- 7. Required dependencies: a parent/child ProductionOrderDependency
  // must be respected when BOTH orders have at least one active operation
  // to compare — an order not yet scheduled (outside this run's scope) is
  // honestly skipped, not assumed compliant or violating.
  const orderIds = [...new Set(activeOps.map((op) => op.productionOrderId))];
  const dependencies = await prisma.productionOrderDependency.findMany({
    where: { OR: [{ parentId: { in: orderIds } }, { childId: { in: orderIds } }] },
  });
  const opsByOrder = new Map<string, { start: Date; end: Date }[]>();
  for (const op of activeOps) {
    opsByOrder.set(op.productionOrderId, [...(opsByOrder.get(op.productionOrderId) ?? []), { start: op.scheduledStart, end: op.scheduledEnd }]);
  }
  for (const dep of dependencies) {
    const parentOps = opsByOrder.get(dep.parentId);
    const childOps = opsByOrder.get(dep.childId);
    if (!parentOps || !childOps) continue;
    const parentLatestEnd = Math.max(...parentOps.map((o) => o.end.getTime()));
    const childEarliestStart = Math.min(...childOps.map((o) => o.start.getTime()));
    if (childEarliestStart < parentLatestEnd) {
      violations.push(
        `Order dependency violated: child order ${dep.childId} starts before parent order ${dep.parentId}'s latest active operation ends`
      );
    }
  }

  return { valid: violations.length === 0, violations };
}

// Minimal day-scoped shift expansion for the exact two-day window a single
// operation can span — @aps/domain's expandShiftWindows is written for a
// multi-day search range; this validator only ever needs shift windows
// covering one specific already-placed operation, so it expands just the
// start day (and the end day, if different) rather than the whole horizon.
function expandShiftWindowsForDay(shifts: { startTime: string; endTime: string; daysOfWeek: number[] }[], start: Date, end: Date): TimeWindow[] {
  const windows: TimeWindow[] = [];
  const days = new Set<number>([
    Math.floor(start.getTime() / 86_400_000),
    Math.floor(end.getTime() / 86_400_000),
  ]);
  for (const dayIndex of days) {
    const dayStart = new Date(dayIndex * 86_400_000);
    const dow = dayStart.getUTCDay();
    for (const shift of shifts) {
      if (!shift.daysOfWeek.includes(dow)) continue;
      const [startH, startM] = shift.startTime.split(":").map(Number);
      const [endH, endM] = shift.endTime.split(":").map(Number);
      const shiftStart = new Date(dayStart.getTime() + (startH * 60 + startM) * 60_000);
      const shiftEnd = new Date(dayStart.getTime() + (endH * 60 + endM) * 60_000);
      windows.push({ start: shiftStart, end: shiftEnd });
    }
  }
  return windows;
}
