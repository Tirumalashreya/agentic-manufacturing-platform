import {
  prisma,
  computePriorityScore,
  checkMachineCapability,
  checkMaterialAvailability,
  checkDeliveryDeadline,
  checkShiftCalendar,
  checkHolidayCalendar,
  checkOperatorSkills,
  resolveAlternativeMachine,
  expandShiftWindows,
  type CustomerTier,
  type SchedulingMode,
  type CapacityAdjustment,
  type TimeWindow,
} from "@aps/domain";
import { getAvailableWindows, reserveCapacity, releaseCapacity, initBucket, getBucket, seedNamespaceFromReal, BUCKET_MINUTES } from "@aps/domain";
import { acquirePlantLock, releasePlantLock, publish, TOPICS, logger, redis } from "@aps/shared";
import { computeCriticalPath, type CpmNode } from "./cpm";

const REFERENCE_MAX_ORDER_VALUE = 100_000;
const REFERENCE_MAX_PENALTY_EXPOSURE = 5_000;
const PLANNING_HORIZON_DAYS = 91; // 13 weeks, per §8's capacity horizon
// Planning Time Fence (real MRP II concept, distinct from the horizon
// above): a near-term frozen zone. An operation already committed to start
// within the next 24h — or already IN_PROGRESS/DONE — must NOT be moved by
// an automatic reschedule, even if a "better" placement exists, because
// production has already committed real resources to it (machine
// mid-setup, material staged). Everything outside this window is freely
// replannable on every run.
const PLANNING_FENCE_HOURS = 24;

export type SimulatedOperation = {
  productionOrderId: string;
  routingOperationId: string;
  machineId: string;
  scheduledStart: string;
  scheduledEnd: string;
};

export type PipelineResult = {
  runId: string;
  ordersProcessed: number;
  operationsScheduled: number;
  conflictsDetected: number;
  scheduleVersion: number;
  // Populated only for What-If dry runs (see WhatIfOptions below) — the rest
  // of this shape (runId/scheduleVersion) is meaningless in that case since
  // nothing was actually written.
  simulatedOperations?: SimulatedOperation[];
};

export type WhatIfOptions = { namespace: string; capacityAdjustments: CapacityAdjustment[] };

// Threaded through every capacity call and the two placement loops when
// running as a What-If dry run; null for a real run (default, unchanged
// behavior/call sites for every existing caller).
type DryRunCtx = { namespace: string; simulatedOperations: SimulatedOperation[]; capacityAdjustments: CapacityAdjustment[] };

export type { SchedulingMode };

// §6, the 11-step pipeline, run against one plant at a time. `whatIf`, when
// passed, runs the identical placement logic (same modes, same constraints)
// against a scratch capacity namespace instead of real Redis buckets and
// collects placements in memory instead of writing to Postgres — see
// DryRunCtx and the What-If-specific branches below.
export async function runSchedulingPipeline(
  plantId: string,
  scope: "ALL" | "AFFECTED" | "SINGLE" = "ALL",
  mode: SchedulingMode = "FORWARD",
  whatIf?: WhatIfOptions
): Promise<PipelineResult> {
  const dryRunCtx: DryRunCtx | null = whatIf
    ? { namespace: whatIf.namespace, simulatedOperations: [], capacityAdjustments: whatIf.capacityAdjustments }
    : null;

  // Step 1: Run Initialisation — skipped for a dry run: no real schedule run
  // is happening, and a scratch-namespaced what-if shouldn't need to block
  // on (or be blocked by) a real run's exclusive plant lock.
  const locked = dryRunCtx ? true : await acquirePlantLock(plantId);
  if (!locked) throw new Error("Another scheduling run is already in progress for this plant");

  const run = dryRunCtx ? null : await prisma.scheduleRun.create({ data: { plantId, scope, status: "RUNNING" } });
  const startedAt = Date.now();
  let conflictsDetected = 0;
  let operationsScheduled = 0;

  try {
    // Step 2: Order Collection & Sort — Priority Score + max-heap queue.
    // (A sorted array drained highest-first is behaviorally identical to
    // draining a max-heap for a one-shot batch run; no heap needed here.)
    const orders = await prisma.productionOrder.findMany({
      where: { plantId, status: { in: ["PLANNED", "RELEASED"] } },
      include: {
        salesOrder: { include: { customer: true } },
        product: { select: { defaultSchedulingMode: true } },
        routing: {
          include: {
            operations: {
              include: {
                predecessors: true,
                successors: true,
                workCenter: {
                  include: {
                    machines: { include: { capabilities: true } },
                    shifts: { include: { shift: true } },
                    // Real SAP-style multi-level Factory Calendar assignment
                    // (Plant, Work Center, Personnel Area) — a work center
                    // can run its own holiday set instead of the plant's.
                    holidayCalendar: { include: { holidays: true } },
                  },
                },
              },
              orderBy: { opNumber: "asc" },
            },
          },
        },
      },
    });

    // §7 Operator Availability/Skills (Hard, when configured): additive,
    // same guard pattern as shift calendars — if NO operators exist at all
    // (true for every plant before this change, confirmed by reading the
    // whole file: "operator" appeared nowhere in it), operator resolution
    // is skipped entirely below and scheduling behaves exactly as before.
    // Operators aren't plant-scoped in this schema (same as Customer/
    // Product), so this queries every operator system-wide, matching the
    // existing GET /operators/available endpoint's own scope. Skipped
    // entirely for What-If dry runs — that simulation stays machine-only,
    // a deliberate scope line so this addition can't regress the
    // already-verified What-If engine.
    const operators = dryRunCtx
      ? []
      : await prisma.operator.findMany({ include: { skills: true, shifts: { include: { shift: true } } } });
    const operatorShiftWindows = new Map<string, TimeWindow[] | null>();

    // §7 Holiday Calendar — fetched once per run, same additive guard as
    // operators/shifts above: a plant with no FactoryCalendar at all (true
    // for every plant before this feature) sees an empty holidayDates array
    // and a null workingDaysOfWeek, and narrowWindowsToHolidays becomes a
    // no-op, so nothing changes for plants that haven't set up a calendar.
    // Split into three named pieces because a Work Center can now override
    // the plant's own weekly pattern / named HolidayCalendar (real SAP-style
    // multi-level assignment — Plant, Work Center, Personnel Area — see
    // resolveCalendarForWorkCenter below): plantDayOverrides (this plant's
    // own one-off FactoryCalendarDay exceptions, e.g. an unplanned shutdown)
    // always apply regardless of work center; plantHolidayCalendarDates and
    // plantWorkingDaysOfWeek are only the FALLBACK a work center uses when
    // it has no override of its own.
    const factoryCalendars = dryRunCtx
      ? []
      : await prisma.factoryCalendar.findMany({
          where: { plantId },
          include: { days: true, holidayCalendar: { include: { holidays: true } } },
        });
    const plantDayOverrides: Date[] = [];
    const plantHolidayCalendarDates: Date[] = [];
    for (const cal of factoryCalendars) {
      for (const d of cal.days) {
        if (d.isHoliday || !d.isWorking) plantDayOverrides.push(d.date);
      }
      for (const h of cal.holidayCalendar?.holidays ?? []) {
        plantHolidayCalendarDates.push(new Date(Date.UTC(h.year, h.month - 1, h.day)));
      }
    }
    // null = no FactoryCalendar configured at all for this plant, i.e. "no
    // weekly restriction" (matches the workingDaysOfWeek column's own
    // default of every weekday when a calendar DOES exist but doesn't
    // override it).
    const plantWorkingDaysOfWeek: number[] | null = factoryCalendars[0]?.workingDaysOfWeek ?? null;

    type CalendarWorkCenter = {
      id: string;
      workingDaysOfWeek: number[];
      holidayCalendarId: string | null;
      holidayCalendar: { holidays: { day: number; month: number; year: number }[] } | null;
    };
    const workCenterCalendarCache = new Map<string, { holidayDates: Date[]; workingDaysOfWeek: number[] | null }>();
    // Real SAP assigns a Factory Calendar at multiple levels (Plant, Work
    // Center, Personnel Area) specifically so different work centers can run
    // different patterns — a work center with neither override set (every
    // work center before this feature: workingDaysOfWeek defaults to `[]`,
    // holidayCalendarId defaults to null) falls through 100% to the plant's
    // own values, identical to this run's behavior before per-work-center
    // overrides existed.
    function resolveCalendarForWorkCenter(workCenter: CalendarWorkCenter): { holidayDates: Date[]; workingDaysOfWeek: number[] | null } {
      const cached = workCenterCalendarCache.get(workCenter.id);
      if (cached) return cached;
      const workingDaysOfWeek = workCenter.workingDaysOfWeek.length > 0 ? workCenter.workingDaysOfWeek : plantWorkingDaysOfWeek;
      const holidayCalendarDates = workCenter.holidayCalendarId
        ? (workCenter.holidayCalendar?.holidays ?? []).map((h) => new Date(Date.UTC(h.year, h.month - 1, h.day)))
        : plantHolidayCalendarDates;
      const resolved = { holidayDates: [...plantDayOverrides, ...holidayCalendarDates], workingDaysOfWeek };
      workCenterCalendarCache.set(workCenter.id, resolved);
      return resolved;
    }
    if (operators.length > 0) {
      const horizonStart = new Date();
      const horizonEnd = new Date(horizonStart.getTime() + PLANNING_HORIZON_DAYS * 86_400_000);
      for (const operator of operators) {
        const shifts = operator.shifts.map((s) => s.shift);
        // null = no shifts configured for this operator = always available
        // time-wise (same "don't block on missing config" principle as
        // work centers with no Shift rows).
        operatorShiftWindows.set(operator.id, shifts.length > 0 ? expandShiftWindows(shifts, horizonStart, horizonEnd) : null);
      }
    }

    for (const order of orders) {
      const score = order.salesOrder
        ? computePriorityScore({
            customerTier: order.salesOrder.customer.tier as CustomerTier,
            dueDate: order.salesOrder.dueDate,
            now: new Date(),
            planningHorizonDays: PLANNING_HORIZON_DAYS,
            orderValue: order.salesOrder.value,
            referenceMaxOrderValue: REFERENCE_MAX_ORDER_VALUE,
            penaltyPerDay: order.salesOrder.customer.penaltyPerDay,
            slaDays: order.salesOrder.customer.slaDays,
            referenceMaxPenaltyExposure: REFERENCE_MAX_PENALTY_EXPOSURE,
            manualOverride: order.manualOverride,
          })
        : order.manualOverride;
      if (!dryRunCtx) await prisma.productionOrder.update({ where: { id: order.id }, data: { priorityScore: score } });
      (order as { priorityScore: number }).priorityScore = score;
    }

    // Step 3: Dependency Resolution — component orders before parent assembly.
    const dependencies = await prisma.productionOrderDependency.findMany({
      where: { OR: orders.map((o) => ({ parentId: o.id })) },
    });
    const orderedByDependency = topologicalOrder(
      orders.map((o) => o.id),
      dependencies.map((d) => ({ before: d.childId, after: d.parentId }))
    );
    const ordersById = new Map(orders.map((o) => [o.id, o]));
    let processingOrder = orderedByDependency
      .map((id) => ordersById.get(id)!)
      .sort((a, b) => b.priorityScore - a.priorityScore || 0);

    // Bottleneck Scheduling (Theory of Constraints / Drum-Buffer-Rope): a
    // real rough-cut capacity estimate — sum every pending operation's
    // duration against each machine capable of running it — identifies the
    // busiest ("drum") machine for THIS batch before anything is placed.
    // Orders touching it get processed first (the drum sets the pace), and
    // — in the per-operation loop below — that machine is tried before any
    // other eligible machine, packing it as tightly as possible.
    // A product can override the run's mode (Product.defaultSchedulingMode)
    // — the run-level `mode` is only the fallback for products that don't
    // specify one. So the bottleneck rough-cut pre-pass must run whenever
    // ANY order in this batch will end up bottleneck-scheduled, not only
    // when the whole run was started in Bottleneck mode.
    const effectiveModeOf = (order: (typeof processingOrder)[number]): SchedulingMode =>
      (order.product?.defaultSchedulingMode as SchedulingMode | null) ?? mode;
    let bottleneckMachineId: string | null = null;
    if (mode === "BOTTLENECK" || processingOrder.some((o) => effectiveModeOf(o) === "BOTTLENECK")) {
      const demandByMachine = new Map<string, number>();
      for (const order of processingOrder) {
        for (const op of order.routing?.operations ?? []) {
          const durationMin = op.processingTimeMin + op.setupTimeMin;
          for (const machine of op.workCenter.machines) {
            if (!checkMachineCapability(machine.capabilities, op.operation).feasible) continue;
            demandByMachine.set(machine.id, (demandByMachine.get(machine.id) ?? 0) + durationMin);
          }
        }
      }
      let maxDemand = 0;
      for (const [machineId, demand] of demandByMachine) {
        if (demand > maxDemand) {
          maxDemand = demand;
          bottleneckMachineId = machineId;
        }
      }

      if (bottleneckMachineId) {
        const touchesBottleneck = (order: (typeof processingOrder)[number]) =>
          (order.routing?.operations ?? []).some((op) => op.workCenter.machines.some((m) => m.id === bottleneckMachineId));
        processingOrder = [...processingOrder].sort((a, b) => {
          const aTouches = touchesBottleneck(a) ? 1 : 0;
          const bTouches = touchesBottleneck(b) ? 1 : 0;
          return bTouches - aTouches || b.priorityScore - a.priorityScore || 0;
        });
        logger.info("Bottleneck machine identified for this run", { plantId, bottleneckMachineId, maxDemand });
      }
    }

    for (const order of processingOrder) {
      if (!order.routing) {
        logger.warn("Order has no routing — skipping", { orderId: order.id });
        continue;
      }

      // Per-order effective mode — Product.defaultSchedulingMode overrides
      // the run's own mode when set; otherwise this order just uses
      // whatever mode the run was started with, identical to today.
      const effectiveMode = effectiveModeOf(order);

      // Step 4: Routing — resolve operation DAG, compute EST/EFT/LST/LFT,
      // mark critical-path operations (float = 0).
      const cpmNodes: CpmNode[] = order.routing.operations.map((op) => ({
        id: op.id,
        durationMin: op.processingTimeMin + op.setupTimeMin,
        predecessorIds: op.predecessors.map((p) => p.predecessorId),
      }));
      const cpmResults = computeCriticalPath(cpmNodes);

      // Planning Time Fence + regenerative replan: every operation this
      // order already has a real ScheduledOperation for is either PROTECTED
      // (already IN_PROGRESS/DONE, or starting within the next
      // PLANNING_FENCE_HOURS — production has committed real resources to
      // it) or fully open to replanning. Protected ones are left completely
      // untouched below (never re-placed, never duplicated). Everything
      // else gets deleted here — a real gap this closes: without this, every
      // rerun just added MORE ScheduledOperation rows on top of the last
      // run's, forever (935 rows found accumulated in the DB for what
      // should've been ~70 real operations) — and released back into Redis
      // (undoing the old reserveCapacity call), since otherwise stale
      // reservations from deleted rows would permanently shrink real
      // capacity across repeated runs. Skipped entirely for What-If dry
      // runs, which must never touch real committed data — a dry run still
      // needs to KNOW which ops are protected (so it doesn't hypothetically
      // move something already in progress), just not delete/release them.
      const fenceNow = new Date();
      const fenceEnd = new Date(fenceNow.getTime() + PLANNING_FENCE_HOURS * 3_600_000);
      const existingOps = await prisma.scheduledOperation.findMany({ where: { productionOrderId: order.id } });
      const protectedByRoutingOpId = new Map<string, (typeof existingOps)[number]>();
      const toRelease: typeof existingOps = [];
      for (const existing of existingOps) {
        // The fence protects the NEAR-TERM upcoming window only
        // (fenceNow..fenceEnd) — a naive `scheduledStart < fenceEnd` would
        // also match everything in the past, since any past date is
        // trivially "before" a future threshold too. A row still sitting at
        // "SCHEDULED" whose start time has already passed didn't actually
        // get started on time — that's a stale/missed placement, not a real
        // in-flight commitment, so it must stay replannable, not protected.
        const startsWithinFence = existing.scheduledStart >= fenceNow && existing.scheduledStart < fenceEnd;
        const isProtected = existing.status === "IN_PROGRESS" || existing.status === "DONE" || startsWithinFence;
        if (isProtected) {
          if (existing.routingOperationId) protectedByRoutingOpId.set(existing.routingOperationId, existing);
        } else {
          toRelease.push(existing);
        }
      }
      if (!dryRunCtx && toRelease.length > 0) {
        const releaseIds = toRelease.map((o) => o.id);
        await prisma.resourceReservation.deleteMany({ where: { scheduledOperationId: { in: releaseIds } } });
        await prisma.scheduledOperation.deleteMany({ where: { id: { in: releaseIds } } });
        for (const old of toRelease) {
          if (!old.machineId) continue;
          const oldDurationMin = (old.scheduledEnd.getTime() - old.scheduledStart.getTime()) / 60_000;
          await releaseCapacity(redis, old.machineId, { start: old.scheduledStart, end: old.scheduledEnd }, oldDurationMin);
        }
      }

      const opEndTimes = new Map<string, Date>();

      if (effectiveMode === "BACKWARD") {
        // Backward Finite (§6 Scheduling Modes): "Start from due date; work
        // backward; respect capacity limits." Walk operations in reverse —
        // each op's latest-allowed-end is bounded by its earliest-starting
        // successor (or the order's due date, for a terminal operation) —
        // and place it at the LAST feasible window rather than the first.
        const dueDate = order.salesOrder?.dueDate ?? new Date(Date.now() + PLANNING_HORIZON_DAYS * 86_400_000);
        const opStartTimes = new Map<string, Date>();

        for (const op of [...order.routing.operations].reverse()) {
          const protectedOp = protectedByRoutingOpId.get(op.id);
          if (protectedOp) {
            // Inside the fence (or already IN_PROGRESS/DONE) — leave it
            // exactly as-is; only feed its real timing into the dependency
            // calculations below so predecessor/successor math stays correct.
            opStartTimes.set(op.id, protectedOp.scheduledStart);
            opEndTimes.set(op.id, protectedOp.scheduledEnd);
            continue;
          }

          const successorStarts = op.successors
            .map((s) => opStartTimes.get(s.successorId))
            .filter((d): d is Date => d != null);
          const latestAllowedEnd = successorStarts.length > 0
            ? new Date(Math.min(...successorStarts.map((d) => d.getTime())))
            : dueDate;

          // Step 5: Material Availability — same check as forward mode; the
          // absolute floor is "now" (can't schedule in the past) unless
          // material pushes it later.
          const materialResult = await checkOperationMaterial(order.productId, order.quantity);
          const materialFloor = materialResult.feasible ? new Date() : materialResult.earliestFeasibleStart ?? new Date();

          const durationMin = op.processingTimeMin + op.setupTimeMin;
          const workCenterMachines = withSyntheticMachines(op.workCenter.machines, op.workCenter.id, dryRunCtx);
          const eligibleMachines = workCenterMachines.filter((m) =>
            checkMachineCapability(m.capabilities, op.operation).feasible
          );

          // Compare every eligible machine and use whichever offers the
          // latest feasible window (Backward mode) — not just the first
          // machine encountered with any window at all. A real bug this
          // exposed: any machine that isn't fully booked across the entire
          // 91-day horizon always has SOME window, so array order alone
          // silently starved every other machine of work — including a
          // hypothetically added What-If machine, which made added capacity
          // do nothing at all.
          type Candidate = { machine: (typeof eligibleMachines)[number]; scheduledStart: Date; scheduledEnd: Date };
          const candidates: Candidate[] = [];
          for (const machine of eligibleMachines) {
            await ensureBucketsInitialized(machine.id, materialFloor, durationMin, dryRunCtx?.namespace);
            let windows = await getAvailableWindows(redis, machine.id, durationMin, materialFloor, latestAllowedEnd, dryRunCtx?.namespace);
            windows = narrowWindowsToShifts(windows, op.workCenter.shifts.map((s) => s.shift), materialFloor, latestAllowedEnd, durationMin);
            const workCenterCalendar = resolveCalendarForWorkCenter(op.workCenter);
            windows = narrowWindowsToHolidays(windows, workCenterCalendar.holidayDates, workCenterCalendar.workingDaysOfWeek, durationMin);
            if (windows.length === 0) continue;

            const chosenWindow = windows[windows.length - 1]; // latest window, not earliest
            const scheduledEnd = new Date(Math.min(chosenWindow.end.getTime(), latestAllowedEnd.getTime()));
            const scheduledStart = new Date(scheduledEnd.getTime() - durationMin * 60_000);
            if (scheduledStart < chosenWindow.start) continue; // doesn't actually fit in this window
            candidates.push({ machine, scheduledStart, scheduledEnd });
          }
          candidates.sort((a, b) => b.scheduledEnd.getTime() - a.scheduledEnd.getTime()); // latest end first

          let placed = false;
          for (const { machine, scheduledStart, scheduledEnd } of candidates) {
            const capacityResult = await reserveCapacity(redis, machine.id, { start: scheduledStart, end: scheduledEnd }, durationMin, dryRunCtx?.namespace);
            if (!capacityResult.feasible) continue;

            if (dryRunCtx) {
              dryRunCtx.simulatedOperations.push({
                productionOrderId: order.id,
                routingOperationId: op.id,
                machineId: machine.id,
                scheduledStart: scheduledStart.toISOString(),
                scheduledEnd: scheduledEnd.toISOString(),
              });
              opStartTimes.set(op.id, scheduledStart);
              opEndTimes.set(op.id, scheduledEnd);
              operationsScheduled++;
              placed = true;
              break;
            }

            try {
              const scheduledOp = await prisma.scheduledOperation.create({
                data: {
                  productionOrderId: order.id,
                  routingOperationId: op.id,
                  machineId: machine.id,
                  scheduledStart,
                  scheduledEnd,
                  status: "SCHEDULED",
                },
              });
              await prisma.resourceReservation.create({
                data: {
                  resourceType: "MACHINE",
                  machineId: machine.id,
                  scheduledOperationId: scheduledOp.id,
                  startTime: scheduledStart,
                  endTime: scheduledEnd,
                  state: "COMMITTED",
                },
              });
              if (operators.length > 0) {
                await resolveAndAssignOperator(
                  scheduledOp.id,
                  { start: scheduledStart, end: scheduledEnd },
                  op.requiredSkillId,
                  op.minProficiency,
                  operators,
                  operatorShiftWindows
                );
              }
              opStartTimes.set(op.id, scheduledStart);
              opEndTimes.set(op.id, scheduledEnd);
              operationsScheduled++;
              placed = true;
              break;
            } catch (error) {
              conflictsDetected++;
              logger.warn("Reservation conflict detected, trying next machine/window", {
                machineId: machine.id,
                opId: op.id,
                error: String(error),
              });
            }
          }

          if (!placed) {
            const altSlot = await tryAlternativeWorkCenters(
              op,
              order.id,
              op.id,
              durationMin,
              materialFloor,
              latestAllowedEnd,
              true,
              dryRunCtx
            );
            if (altSlot) {
              conflictsDetected += altSlot.conflicts;
              operationsScheduled++;
              opStartTimes.set(op.id, altSlot.start);
              opEndTimes.set(op.id, altSlot.end);
            } else {
              logger.warn("Could not place operation within horizon", { opId: op.id, orderId: order.id });
              opStartTimes.set(op.id, latestAllowedEnd);
              opEndTimes.set(op.id, latestAllowedEnd);
            }
          }

          void cpmResults.get(op.id)?.isCritical;
        }
      } else {
        // Forward Finite (default): "Start from earliest feasible date; fill
        // forward in time; respect capacity limits."
        const orderNotBefore = new Date();

        for (const op of order.routing.operations) {
          const protectedOp = protectedByRoutingOpId.get(op.id);
          if (protectedOp) {
            // Inside the fence (or already IN_PROGRESS/DONE) — leave it
            // exactly as-is; only feed its real end time into successor
            // dependency math below.
            opEndTimes.set(op.id, protectedOp.scheduledEnd);
            continue;
          }

          const predecessorEnds = op.predecessors
            .map((p) => opEndTimes.get(p.predecessorId))
            .filter((d): d is Date => d != null);
          const earliestStart = predecessorEnds.length > 0
            ? new Date(Math.max(...predecessorEnds.map((d) => d.getTime())))
            : orderNotBefore;

          // Step 5: Material Availability — check BOM components' stock
          // against the full order quantity (only the first operation in a
          // routing typically consumes raw BOM components, but re-checking on
          // every op is harmless: once an earlier op is pushed out, later
          // ops' dependency floor already accounts for it).
          const materialResult = await checkOperationMaterial(order.productId, order.quantity);
          const materialFloor = materialResult.feasible ? earliestStart : materialResult.earliestFeasibleStart ?? earliestStart;
          const effectiveEarliestStart = materialFloor > earliestStart ? materialFloor : earliestStart;

          // Step 6 + 7 + 8: Capacity, Constraint Evaluation, Resource Selection.
          const durationMin = op.processingTimeMin + op.setupTimeMin;
          const workCenterMachines = withSyntheticMachines(op.workCenter.machines, op.workCenter.id, dryRunCtx);
          const eligibleMachines = workCenterMachines.filter((m) =>
            checkMachineCapability(m.capabilities, op.operation).feasible
          );

          const searchEnd = new Date(effectiveEarliestStart.getTime() + PLANNING_HORIZON_DAYS * 86_400_000);

          // Compare every eligible machine and use whichever offers the
          // earliest feasible window — not just the first machine
          // encountered with any window at all. A real bug this exposed: any
          // machine that isn't fully booked across the entire 91-day horizon
          // always has SOME window, so array order alone silently starved
          // every other machine of work — including a hypothetically added
          // What-If machine, which made added capacity do nothing at all.
          type Candidate = { machine: (typeof eligibleMachines)[number]; scheduledStart: Date; scheduledEnd: Date };
          const candidates: Candidate[] = [];
          for (const machine of eligibleMachines) {
            await ensureBucketsInitialized(machine.id, effectiveEarliestStart, durationMin, dryRunCtx?.namespace);
            let windows = await getAvailableWindows(redis, machine.id, durationMin, effectiveEarliestStart, searchEnd, dryRunCtx?.namespace);
            windows = narrowWindowsToShifts(windows, op.workCenter.shifts.map((s) => s.shift), effectiveEarliestStart, searchEnd, durationMin);
            const workCenterCalendar = resolveCalendarForWorkCenter(op.workCenter);
            windows = narrowWindowsToHolidays(windows, workCenterCalendar.holidayDates, workCenterCalendar.workingDaysOfWeek, durationMin);
            if (windows.length === 0) continue;
            candidates.push({ machine, scheduledStart: windows[0].start, scheduledEnd: new Date(windows[0].start.getTime() + durationMin * 60_000) });
          }
          // Bottleneck mode is the one deliberate exception: the drum
          // machine should pack as tightly as possible regardless of whether
          // some other machine happens to be idle sooner (that's the whole
          // point of identifying it) — so it wins ties against the clock,
          // not just ties in time.
          candidates.sort((a, b) => {
            if (effectiveMode === "BOTTLENECK" && bottleneckMachineId) {
              const aIsDrum = a.machine.id === bottleneckMachineId;
              const bIsDrum = b.machine.id === bottleneckMachineId;
              if (aIsDrum !== bIsDrum) return aIsDrum ? -1 : 1;
            }
            return a.scheduledStart.getTime() - b.scheduledStart.getTime();
          });

          let placed = false;
          for (const { machine, scheduledStart, scheduledEnd } of candidates) {
            const capacityResult = await reserveCapacity(redis, machine.id, { start: scheduledStart, end: scheduledEnd }, durationMin, dryRunCtx?.namespace);
            if (!capacityResult.feasible) continue;

            if (dryRunCtx) {
              dryRunCtx.simulatedOperations.push({
                productionOrderId: order.id,
                routingOperationId: op.id,
                machineId: machine.id,
                scheduledStart: scheduledStart.toISOString(),
                scheduledEnd: scheduledEnd.toISOString(),
              });
              opEndTimes.set(op.id, scheduledEnd);
              operationsScheduled++;
              placed = true;
              break;
            }

            try {
              const scheduledOp = await prisma.scheduledOperation.create({
                data: {
                  productionOrderId: order.id,
                  routingOperationId: op.id,
                  machineId: machine.id,
                  scheduledStart,
                  scheduledEnd,
                  status: "SCHEDULED",
                },
              });
              // Step 9: Conflict Detection — the GiST exclusion constraint
              // (verified separately against real Postgres) is what actually
              // enforces "no two COMMITTED reservations overlap"; this insert
              // either succeeds or throws, which is the post-pass check.
              await prisma.resourceReservation.create({
                data: {
                  resourceType: "MACHINE",
                  machineId: machine.id,
                  scheduledOperationId: scheduledOp.id,
                  startTime: scheduledStart,
                  endTime: scheduledEnd,
                  state: "COMMITTED",
                },
              });
              if (operators.length > 0) {
                await resolveAndAssignOperator(
                  scheduledOp.id,
                  { start: scheduledStart, end: scheduledEnd },
                  op.requiredSkillId,
                  op.minProficiency,
                  operators,
                  operatorShiftWindows
                );
              }
              opEndTimes.set(op.id, scheduledEnd);
              operationsScheduled++;
              placed = true;
              break;
            } catch (error) {
              conflictsDetected++;
              logger.warn("Reservation conflict detected, trying next machine/window", {
                machineId: machine.id,
                opId: op.id,
                error: String(error),
              });
            }
          }

          if (!placed) {
            const altSlot = await tryAlternativeWorkCenters(
              op,
              order.id,
              op.id,
              durationMin,
              effectiveEarliestStart,
              searchEnd,
              false,
              dryRunCtx
            );
            if (altSlot) {
              conflictsDetected += altSlot.conflicts;
              operationsScheduled++;
              opEndTimes.set(op.id, altSlot.end);
            } else {
              logger.warn("Could not place operation within horizon", { opId: op.id, orderId: order.id });
              opEndTimes.set(op.id, effectiveEarliestStart);
            }
          }

          void cpmResults.get(op.id)?.isCritical; // critical-path flag available for reporting/UI
        }
      }

      const orderScheduledEnd = order.routing.operations.length
        ? Array.from(opEndTimes.values()).reduce((max, d) => (d > max ? d : max), new Date(0))
        : null;

      // Step 14-equivalent check inline: Delivery Deadline (Hard SLA)
      if (orderScheduledEnd && order.salesOrder) {
        const deadlineCheck = checkDeliveryDeadline(orderScheduledEnd, order.salesOrder.dueDate);
        if (deadlineCheck.feasible === false) {
          logger.warn("Order will miss its delivery deadline", { orderId: order.id, reason: deadlineCheck.reason });
        }
      }

      if (!dryRunCtx) {
        await prisma.productionOrder.update({
          where: { id: order.id },
          data: {
            status: "RELEASED",
            scheduledStart: order.routing.operations.length ? new Date() : undefined,
            scheduledEnd: orderScheduledEnd ?? undefined,
          },
        });
      }
    }

    // A What-If run stops here — no optimization pass, no schedule
    // publishing, nothing to mark COMPLETED, since none of that real-run
    // machinery applies to a hypothetical preview that wrote nothing.
    if (dryRunCtx) {
      return {
        runId: "",
        ordersProcessed: orders.length,
        operationsScheduled,
        conflictsDetected,
        scheduleVersion: 0,
        simulatedOperations: dryRunCtx.simulatedOperations,
      };
    }

    // Step 10: Optimisation Pass — best-effort call to optimization-service;
    // this pipeline still produces a valid, conflict-free schedule without
    // it, so a down/not-yet-built optimizer degrades gracefully rather than
    // failing the whole run.
    await tryOptimizationPass(plantId);

    // Step 11: Schedule Publishing
    const latestSchedule = await prisma.schedule.findFirst({ where: { plantId }, orderBy: { versionNumber: "desc" } });
    const nextVersion = (latestSchedule?.versionNumber ?? 0) + 1;
    const schedule = await prisma.schedule.create({
      data: { plantId, versionNumber: nextVersion, kpiOnTimePct: null, kpiUtilizationPct: null },
    });

    await publish(TOPICS.SCHEDULE_PUBLISHED, { plantId, scheduleId: schedule.id, versionNumber: nextVersion });

    await prisma.scheduleRun.update({
      where: { id: run!.id },
      data: {
        status: "COMPLETED",
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt,
        conflictsDetected,
      },
    });

    return {
      runId: run!.id,
      ordersProcessed: orders.length,
      operationsScheduled,
      conflictsDetected,
      scheduleVersion: nextVersion,
    };
  } catch (error) {
    if (!dryRunCtx) {
      await prisma.scheduleRun.update({
        where: { id: run!.id },
        data: { status: "FAILED", finishedAt: new Date(), durationMs: Date.now() - startedAt },
      });
    }
    throw error;
  } finally {
    if (!dryRunCtx) await releasePlantLock(plantId);
  }
}

export type LeadTimePreviewOperation = {
  routingOperationId: string;
  operation: string;
  projectedStart: string;
  projectedEnd: string;
  isCritical: boolean;
};

export type LeadTimePreviewOrder = {
  productionOrderId: string;
  productSku: string;
  dueDate: string | null;
  projectedCompletion: string | null;
  operations: LeadTimePreviewOperation[];
};

// Lead-Time Scheduling: a rough-cut, capacity-blind projection — pure
// duration math (cumulative processing+setup time through the operation
// DAG), the same CPM machinery the real pipeline uses for EST/EFT, just
// anchored at "now" and returned directly rather than checked against real
// machine capacity. Read-only: no ScheduleRun, no ScheduledOperation, no
// ResourceReservation — this never commits anything, matching §6's
// "Infinite (Load Analysis): ignore capacity; produce a load profile" intent
// (used for rough-cut estimates / ERP CRP reports, not execution).
export async function computeLeadTimePreview(plantId: string): Promise<LeadTimePreviewOrder[]> {
  const orders = await prisma.productionOrder.findMany({
    where: { plantId, status: { in: ["PLANNED", "RELEASED"] } },
    include: {
      product: true,
      salesOrder: true,
      routing: { include: { operations: { include: { predecessors: true }, orderBy: { opNumber: "asc" } } } },
    },
  });

  const now = Date.now();
  return orders.map((order) => {
    if (!order.routing || order.routing.operations.length === 0) {
      return {
        productionOrderId: order.id,
        productSku: order.product.sku,
        dueDate: order.salesOrder?.dueDate.toISOString() ?? null,
        projectedCompletion: null,
        operations: [],
      };
    }

    const cpmNodes: CpmNode[] = order.routing.operations.map((op) => ({
      id: op.id,
      durationMin: op.processingTimeMin + op.setupTimeMin,
      predecessorIds: op.predecessors.map((p) => p.predecessorId),
    }));
    const cpmResults = computeCriticalPath(cpmNodes);

    const operations: LeadTimePreviewOperation[] = order.routing.operations.map((op) => {
      const result = cpmResults.get(op.id)!;
      return {
        routingOperationId: op.id,
        operation: op.operation,
        projectedStart: new Date(now + result.est * 60_000).toISOString(),
        projectedEnd: new Date(now + result.eft * 60_000).toISOString(),
        isCritical: result.isCritical,
      };
    });

    const projectedCompletionMin = Math.max(...Array.from(cpmResults.values()).map((r) => r.eft));

    return {
      productionOrderId: order.id,
      productSku: order.product.sku,
      dueDate: order.salesOrder?.dueDate.toISOString() ?? null,
      projectedCompletion: new Date(now + projectedCompletionMin * 60_000).toISOString(),
      operations,
    };
  });
}

// Kahn's algorithm: `before` must come earlier in the result than `after`.
function topologicalOrder(nodeIds: string[], edges: { before: string; after: string }[]): string[] {
  const inDegree = new Map(nodeIds.map((id) => [id, 0]));
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    adjacency.set(edge.before, [...(adjacency.get(edge.before) ?? []), edge.after]);
    inDegree.set(edge.after, (inDegree.get(edge.after) ?? 0) + 1);
  }
  const queue = nodeIds.filter((id) => (inDegree.get(id) ?? 0) === 0);
  const result: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    result.push(id);
    for (const next of adjacency.get(id) ?? []) {
      inDegree.set(next, (inDegree.get(next) ?? 1) - 1);
      if (inDegree.get(next) === 0) queue.push(next);
    }
  }
  // Cycle fallback: append anything Kahn's couldn't resolve, in original order.
  for (const id of nodeIds) if (!result.includes(id)) result.push(id);
  return result;
}

async function checkOperationMaterial(productId: string, requiredQty: number) {
  if (requiredQty <= 0) return { feasible: true as const };
  const bom = await prisma.bOM.findFirst({ where: { productId }, include: { lines: true } });
  if (!bom) return { feasible: true as const }; // no BOM defined — nothing to check

  for (const line of bom.lines) {
    const inventory = await prisma.inventory.findMany({ where: { productId: line.componentId } });
    const stock = inventory.reduce((sum, i) => sum + i.qtyUnrestricted, 0);
    const reserved = inventory.reduce((sum, i) => sum + i.qtyReserved, 0);
    const inbound = await prisma.purchaseOrder.findMany({
      where: { productSku: line.componentId, confirmed: true, expectedDate: { gte: new Date() } },
      orderBy: { expectedDate: "asc" },
    });
    const confirmedInboundQty = inbound.reduce((sum, po) => sum + po.quantity, 0);
    const required = line.quantityPer * requiredQty;

    const result = checkMaterialAvailability({ stock, priorReservations: reserved, confirmedInbound: confirmedInboundQty, required });
    if (!result.feasible) {
      const earliestInbound = inbound[0]?.expectedDate ?? null;
      return { feasible: false as const, earliestFeasibleStart: earliestInbound ?? undefined };
    }
  }
  return { feasible: true as const };
}

// 15 days — bumped from 1 day (96 buckets) once the Holiday Calendar
// feature could legitimately block a machine for multiple consecutive
// days: with only 1 day of lookahead guaranteed, a 2-day holiday alone
// made getAvailableWindows come back empty even though real open capacity
// existed right after it, since no buckets existed there yet to report as
// open. 15 days comfortably covers any realistic holiday block (a
// long weekend, a week-long shutdown) without initializing buckets across
// the entire 91-day horizon on every single placement attempt (a real
// performance cost that scales with how many machines/operations a run
// touches — bounded here instead of tied to how far out a due date is).
const MIN_LOOKAHEAD_BUCKETS = 1440;

// Must be idempotent: this runs before every placement attempt, potentially
// over a range that already has reservations from an earlier operation on
// the same machine. initBucket() itself unconditionally zeroes a bucket's
// used/reserved capacity, so re-initializing an already-reserved bucket
// would silently wipe out a prior operation's booking — checked here first
// so only genuinely new buckets get created.
// §7 Shift Calendar (Hard): a work center with zero configured Shift rows
// (true for every plant as of this writing, since nothing populated them
// before now) must NOT be restricted — checkShiftCalendar's .some() over an
// empty activeShiftWindows array returns infeasible unconditionally, which
// would make every operation on every unconfigured work center unplaceable.
// Only narrow when shifts are actually configured.
function narrowWindowsToShifts(
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
function narrowWindowsToHolidays(
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

type OperatorCandidate = {
  id: string;
  skills: { skillId: string; proficiency: string; certifiedUntil: Date | null }[];
};

// §7 Operator Availability (Hard) + Operator Skills (Hard), applied only
// when at least one Operator exists (see the pipeline's guard at the order
// query). Tries each operator in order: shift coverage (skip entirely if
// the operator has no shifts configured — always available time-wise, same
// principle as work centers with no Shift rows), required skill/proficiency
// via the already-written checkOperatorSkills, then a real conflict check
// against COMMITTED ResourceReservation rows (the same GiST exclusion
// constraint that protects machine bookings already has an operator-scoped
// twin — resource_reservation_operator_no_overlap — confirmed in the
// schema, just never exercised until now). Soft on failure: if no qualified
// available operator is found, the operation stays machine-only rather
// than failing to schedule — see the plan's reasoning for starting soft.
async function resolveAndAssignOperator(
  scheduledOperationId: string,
  window: TimeWindow,
  requiredSkillId: string | null,
  minProficiency: string | null,
  operators: OperatorCandidate[],
  operatorShiftWindows: Map<string, TimeWindow[] | null>
): Promise<void> {
  const now = new Date();
  for (const operator of operators) {
    const shiftWindows = operatorShiftWindows.get(operator.id);
    if (shiftWindows) {
      const withinShift = shiftWindows.some((w) => window.start >= w.start && window.end <= w.end);
      if (!withinShift) continue;
    }

    if (requiredSkillId) {
      const skill = operator.skills.find((s) => s.skillId === requiredSkillId);
      const skillCheck = checkOperatorSkills({
        operatorProficiency: (skill?.proficiency as "TRAINEE" | "STANDARD" | "EXPERT" | undefined) ?? null,
        minProficiency: (minProficiency as "TRAINEE" | "STANDARD" | "EXPERT" | null) ?? "TRAINEE",
        certificationExpiresAt: skill?.certifiedUntil ?? null,
        now,
      });
      if (!skillCheck.feasible) continue;
    }

    const conflict = await prisma.resourceReservation.findFirst({
      where: {
        operatorId: operator.id,
        state: "COMMITTED",
        startTime: { lt: window.end },
        endTime: { gt: window.start },
      },
    });
    if (conflict) continue;

    try {
      await prisma.scheduledOperation.update({ where: { id: scheduledOperationId }, data: { operatorId: operator.id } });
      await prisma.resourceReservation.create({
        data: {
          resourceType: "OPERATOR",
          operatorId: operator.id,
          scheduledOperationId,
          startTime: window.start,
          endTime: window.end,
          state: "COMMITTED",
        },
      });
      return;
    } catch (error) {
      logger.warn("Operator reservation conflict, trying next operator", { operatorId: operator.id, error: String(error) });
    }
  }
  // No qualified/available operator found — operation stays machine-only.
}

// namespace="" (default, every real caller) behaves exactly as before. A
// What-If dry run's namespace first tries to copy the REAL bucket's exact
// current state (seedNamespaceFromReal) — a hypothetical run must start from
// the real current load/reservations, not a blank slate, or the before/after
// comparison it exists to produce would be meaningless — and only falls
// back to a fresh/open bucket if no real bucket exists yet for that slot
// either (matching what the real pipeline would do in that same case).
async function ensureBucketsInitialized(machineId: string, from: Date, spanMinNeeded: number, namespace = "") {
  const bucketsNeeded = Math.max(Math.ceil(spanMinNeeded / BUCKET_MINUTES) + 4, MIN_LOOKAHEAD_BUCKETS);
  for (let i = 0; i < bucketsNeeded; i++) {
    const bucketTime = new Date(from.getTime() + i * BUCKET_MINUTES * 60_000);
    const existing = await getBucket(redis, machineId, bucketTime, namespace);
    if (existing) continue;
    if (namespace) await seedNamespaceFromReal(redis, machineId, bucketTime, namespace);
    const stillMissing = namespace ? !(await getBucket(redis, machineId, bucketTime, namespace)) : true;
    if (stillMissing) await initBucket(redis, machineId, bucketTime, BUCKET_MINUTES, namespace);
  }
}

// What-If's one capacity lever: hypothetically add N more machines' worth of
// capacity to a work center (see CapacityAdjustment's doc-comment for why
// this is the only lever in v1). Synthetic machines clone a real capable
// machine's capabilities so they pass the same capability filter callers
// apply right after, under a namespace-only id — ensureBucketsInitialized
// naturally gives them fresh/open buckets since no real machine of that id
// exists to copy from, which is exactly the intended "brand new capacity"
// semantics.
//
// Placed FIRST, before the real machines: the placement loop below takes the
// first eligible machine offering ANY feasible window, not the one offering
// the globally-earliest window across all candidates (true of the real
// pipeline too — out of scope to change here). A real, already-loaded
// machine almost always has SOME window somewhere in the 91-day horizon, so
// appending synthetic machines after it left them completely unreachable —
// confirmed via a real run where added capacity made no difference at all.
// Trying idle new capacity first is also the more sensible modeling choice
// for what a hypothetical capacity add should demonstrate.
function withSyntheticMachines<M extends { id: string }>(machines: M[], workCenterId: string, dryRunCtx: DryRunCtx | null): M[] {
  if (!dryRunCtx || machines.length === 0) return machines;
  const adjustment = dryRunCtx.capacityAdjustments.find((a) => a.workCenterId === workCenterId);
  if (!adjustment || adjustment.additionalMachineCount <= 0) return machines;
  const template = machines[0];
  const synthetic = Array.from({ length: adjustment.additionalMachineCount }, (_, i) => ({
    ...template,
    id: `whatif-synthetic-${workCenterId}-${i}`,
  }));
  return [...synthetic, ...machines];
}

// §7 "Alternative Machines (Resolution): When primary fails, evaluate
// alternative_work_centers in priority order until feasible." Called only
// after every machine in the operation's own work center has failed to
// offer a window — `resolveAlternativeMachine` (packages/domain) picks the
// first alt work center with a capable machine (a synchronous filter over
// already-fetched capability data); the actual capacity/window search below
// is the same async logic used for the primary work center.
async function tryAlternativeWorkCenters(
  op: { operation: string; alternativeWorkCenterIds: string[] },
  orderId: string,
  routingOperationId: string,
  durationMin: number,
  searchStart: Date,
  searchEnd: Date,
  pickLatest: boolean,
  dryRunCtx: DryRunCtx | null = null
): Promise<{ start: Date; end: Date; conflicts: number } | null> {
  if (op.alternativeWorkCenterIds.length === 0) return null;

  const workCenters = await prisma.workCenter.findMany({
    where: { id: { in: op.alternativeWorkCenterIds } },
    include: { machines: { include: { capabilities: true } } },
  });
  const byId = new Map(workCenters.map((wc) => [wc.id, wc]));
  const orderedWorkCenters = op.alternativeWorkCenterIds
    .map((id) => byId.get(id))
    .filter((wc): wc is NonNullable<typeof wc> => wc != null);

  const chosenWorkCenter = resolveAlternativeMachine(orderedWorkCenters, (wc) =>
    wc.machines.some((m) => checkMachineCapability(m.capabilities, op.operation).feasible)
  );
  if (!chosenWorkCenter) return null;

  const workCenterMachines = withSyntheticMachines(chosenWorkCenter.machines, chosenWorkCenter.id, dryRunCtx);
  const eligibleMachines = workCenterMachines.filter((m) =>
    checkMachineCapability(m.capabilities, op.operation).feasible
  );

  let conflicts = 0;
  for (const machine of eligibleMachines) {
    await ensureBucketsInitialized(machine.id, searchStart, durationMin, dryRunCtx?.namespace);
    const windows = await getAvailableWindows(redis, machine.id, durationMin, searchStart, searchEnd, dryRunCtx?.namespace);
    if (windows.length === 0) continue;

    const chosenWindow = pickLatest ? windows[windows.length - 1] : windows[0];
    let start: Date;
    let end: Date;
    if (pickLatest) {
      end = new Date(Math.min(chosenWindow.end.getTime(), searchEnd.getTime()));
      start = new Date(end.getTime() - durationMin * 60_000);
      if (start < chosenWindow.start) continue;
    } else {
      start = chosenWindow.start;
      end = new Date(start.getTime() + durationMin * 60_000);
    }

    const capacityResult = await reserveCapacity(redis, machine.id, { start, end }, durationMin, dryRunCtx?.namespace);
    if (!capacityResult.feasible) continue;

    if (dryRunCtx) {
      dryRunCtx.simulatedOperations.push({
        productionOrderId: orderId,
        routingOperationId,
        machineId: machine.id,
        scheduledStart: start.toISOString(),
        scheduledEnd: end.toISOString(),
      });
      return { start, end, conflicts };
    }

    try {
      const scheduledOp = await prisma.scheduledOperation.create({
        data: {
          productionOrderId: orderId,
          routingOperationId,
          machineId: machine.id,
          scheduledStart: start,
          scheduledEnd: end,
          status: "SCHEDULED",
        },
      });
      await prisma.resourceReservation.create({
        data: {
          resourceType: "MACHINE",
          machineId: machine.id,
          scheduledOperationId: scheduledOp.id,
          startTime: start,
          endTime: end,
          state: "COMMITTED",
        },
      });
      return { start, end, conflicts };
    } catch (error) {
      conflicts++;
      logger.warn("Reservation conflict detected on alternate work center", {
        machineId: machine.id,
        opId: routingOperationId,
        error: String(error),
      });
    }
  }
  return null;
}

async function tryOptimizationPass(plantId: string) {
  try {
    const url = process.env.OPTIMIZATION_SERVICE_URL ?? "http://localhost:4006";
    const response = await fetch(`${url}/optimize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plantId }),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error(`optimization-service returned ${response.status}`);
    logger.info("Optimization pass completed", { plantId });
  } catch (error) {
    logger.warn("Optimization pass skipped (optimization-service unavailable)", { error: String(error) });
  }
}
