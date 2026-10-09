import {
  prisma,
  computePriorityScore,
  checkMachineCapability,
  checkMaterialAvailability,
  checkDeliveryDeadline,
  checkOperatorSkills,
  resolveAlternativeMachine,
  expandShiftWindows,
  narrowWindowsToShifts,
  narrowWindowsToHolidays,
  type CustomerTier,
  type SchedulingMode,
  type CapacityAdjustment,
  type TimeWindow,
  type Prisma,
} from "@aps/domain";
import { getAvailableWindows, reserveCapacity, releaseCapacity, initBucket, getBucket, seedNamespaceFromReal, BUCKET_MINUTES } from "@aps/domain";
import { acquirePlantLock, releasePlantLock, renewPlantLock, PLANT_LOCK_RENEWAL_INTERVAL_MS, publishTracked, TOPICS, logger, redis, internalServiceHeaders } from "@aps/shared";
import { computeCriticalPath, type CpmNode } from "./cpm";
import { validateScheduleFeasibility } from "./schedule-validator";
import { resolveEnterpriseId } from "./idempotency";
import { randomUUID } from "node:crypto";

const REFERENCE_MAX_ORDER_VALUE = 100_000;
const REFERENCE_MAX_PENALTY_EXPOSURE = 5_000;
const PLANNING_HORIZON_DAYS = 91; // 13 weeks, per §8's capacity horizon
// Bounded future-slot lookahead (Phase 2, agreed with the user) — when an
// operation can't be placed within the normal horizon, the FORWARD-mode
// placement loop below gets exactly one more attempt at this wider,
// still-fixed horizon before giving up. Deliberately not "search until
// found": a permanently unplaceable operation (impossible dependency chain,
// no eligible machine at all) must still fail cleanly rather than searching
// forever. 182 days = 26 weeks, double the normal horizon — a real bound,
// not a guess dressed up as one.
const EXTENDED_HORIZON_DAYS = 182;
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
  // Phase 2 (agreed with the user) — true only when this placement needed
  // the extended-horizon retry (see EXTENDED_HORIZON_DAYS); absent/false
  // for a normal within-horizon placement. Lets a caller (apsAgent.ts's
  // planProduction) tell "fits fine" apart from "only fits later" without
  // a second field to keep in sync.
  viaExtendedHorizon?: boolean;
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
  // Real scope reporting (agreed with the user): a caller that asked for
  // SINGLE/AFFECTED needs to be able to confirm the response actually
  // matches what was requested, not just trust it — never inferred, always
  // the literal scope/seed this run was given and the literal order set
  // resolveScopedOrderIds() computed for it. Present for every run
  // (ALL included, where scopedOrderIds is null — nothing was narrowed).
  scope: "ALL" | "AFFECTED" | "SINGLE";
  targetOrderId?: string;
  scopedOrderIds?: string[];
  // Stage 01 HIGH-risk debt closure: present only when the real,
  // already-committed Schedule above was successfully computed but the
  // SCHEDULE_PUBLISHED Kafka publish itself failed — never means the run
  // failed (status is still COMPLETED when this is set).
  syncWarning?: string;
};

// Real SINGLE/AFFECTED resolution (agreed with the user, replacing a
// previously-reverted build with one extra real signal). Factored out as
// its own function so the real committing run below and the read-only
// preview endpoint (GET /scheduling/affected-orders) can never define
// "affected" two different ways — one call site, one definition.
//
// SINGLE = just the seed order.
// AFFECTED = the seed order, plus:
//   (a) any other open order sharing a real workCenterId via its routing
//       operations — genuine capacity contention, not a guess.
//   (b) any other open order linked to the seed order via a real
//       ProductionOrderDependency edge (either direction) — the existing
//       BOM-assembly-hierarchy dependency table the pipeline's own Step 3
//       already uses; rescheduling a component changes when its parent
//       assembly can start, and vice versa, so that's a genuine
//       "sequencing dependency" affected-order signal, not fabricated.
// Never invents data: an order with no shared work center and no
// dependency edge is never included, regardless of scope.
export async function resolveScopedOrderIds(
  plantId: string,
  scope: "ALL" | "AFFECTED" | "SINGLE",
  seedProductionOrderId?: string
): Promise<{ scopedOrderIds: string[] | null; targetOrderId?: string }> {
  if (!seedProductionOrderId || scope === "ALL") return { scopedOrderIds: null };

  const seedOrder = await prisma.productionOrder.findUnique({
    where: { id: seedProductionOrderId },
    include: { routing: { include: { operations: { select: { workCenterId: true } } } } },
  });
  if (!seedOrder) throw new Error(`No production order found with id ${seedProductionOrderId}`);

  if (scope === "SINGLE") {
    return { scopedOrderIds: [seedOrder.id], targetOrderId: seedOrder.id };
  }

  const workCenterIds = [...new Set(seedOrder.routing?.operations.map((op) => op.workCenterId) ?? [])];
  const sharingOrders = workCenterIds.length > 0
    ? await prisma.productionOrder.findMany({
        where: {
          plantId,
          status: { in: ["PLANNED", "RELEASED"] },
          id: { not: seedOrder.id },
          routing: { operations: { some: { workCenterId: { in: workCenterIds } } } },
        },
        select: { id: true },
      })
    : [];

  const dependencyEdges = await prisma.productionOrderDependency.findMany({
    where: { OR: [{ parentId: seedOrder.id }, { childId: seedOrder.id }] },
    select: { parentId: true, childId: true },
  });
  const dependencyLinkedIds = new Set<string>();
  for (const edge of dependencyEdges) {
    dependencyLinkedIds.add(edge.parentId === seedOrder.id ? edge.childId : edge.parentId);
  }

  const affectedIds = new Set<string>([seedOrder.id, ...sharingOrders.map((o) => o.id), ...dependencyLinkedIds]);
  return { scopedOrderIds: [...affectedIds], targetOrderId: seedOrder.id };
}

// Phase 11 (Promise Monitoring & Agentic Recovery) — the exact disruption
// taxonomy every autoReschedule call site (index.ts) already names in its
// own free-text `reason` string, now a real typed value instead of
// something checkPromiseImpact would have to re-parse out of prose.
export type DisruptionType = "ORDER_CANCELLED" | "ORDER_QTY_CHANGED" | "MACHINE_BREAKDOWN" | "MACHINE_REPAIRED" | "MAINTENANCE_SCHEDULED";

// Kept here (not index.ts, which starts real Kafka/Redis consumers as a
// side effect of being imported at all — confirmed by every existing test
// in this file's own test suite importing ONLY from pipeline.ts, never
// index.ts) so this function is directly unit-testable the same way
// resolveScopedOrderIds/runSchedulingPipeline already are.
//
// Scheduling-service remains fully deterministic — it never calls an LLM
// itself (the architecture contract's own no_llm_outside_agent_orchestrator
// check guards this). This is a plain service-to-service dispatch, same
// convention mes-integration's own AGENT_ORCHESTRATOR_URL call already
// established for the reverse (TS -> Python) direction.
const AGENT_ORCHESTRATOR_URL = process.env.AGENT_ORCHESTRATOR_URL ?? "http://localhost:8000";

// Deterministic only. For each order a reschedule run actually touched,
// checks whether a real, already-committed customer promise is still
// satisfied by the NEW schedule.
//
// The promise itself is read from FulfillmentLine.promisedDate — the real,
// persisted field agent-orchestrator's _execute_production_plan already
// writes at approval time (see graph.py) — not something invented for
// this phase. An order with no promisedDate (most orders today — not
// every order routes through the Phase 10 approval flow yet) has nothing
// to protect and is silently skipped, never reported as "safe" (that
// would be fabricating a promise that was never made).
export async function checkPromiseImpact(
  plantId: string,
  scopedOrderIds: string[],
  scheduleRunId: string,
  disruptionType: DisruptionType,
  affectedResourceId: string | undefined,
  reason: string
): Promise<void> {
  const traceId = randomUUID();
  for (const productionOrderId of scopedOrderIds) {
    const fulfillmentLine = await prisma.fulfillmentLine.findFirst({
      where: { productionOrderId, promisedDate: { not: null } },
      orderBy: { updatedAt: "desc" },
    });
    if (!fulfillmentLine || !fulfillmentLine.promisedDate) continue;

    const productionOrder = await prisma.productionOrder.findUnique({
      where: { id: productionOrderId },
      include: { salesOrder: { include: { customer: true } } },
    });
    if (!productionOrder) continue;

    const newOps = await prisma.scheduledOperation.findMany({
      where: { productionOrderId },
      select: { scheduledEnd: true },
    });
    const currentPromisedDate = newOps.length > 0 ? new Date(Math.max(...newOps.map((o) => o.scheduledEnd.getTime()))) : null;

    const originalPromisedDate = fulfillmentLine.promisedDate;
    const satisfied = currentPromisedDate !== null && currentPromisedDate.getTime() <= originalPromisedDate.getTime();

    if (satisfied) {
      // §4/§10/§13: the LLM is never called just to say an order is still
      // on time — this is the entire check, and it stops right here.
      await prisma.scheduleAuditLog.create({
        data: {
          entityType: "ProductionOrder",
          entityId: productionOrderId,
          after: {
            event: "PROMISE_REMAINS_SAFE",
            disruptionType,
            reason,
            scheduleRunId,
            originalPromisedDate: originalPromisedDate.toISOString(),
            currentPromisedDate: currentPromisedDate?.toISOString() ?? null,
          },
        },
      });
      continue;
    }

    // Promise breached. Idempotent dispatch — reuses the EXACT same
    // IdempotencyKey table/claim semantics Stage 03C/Stage 05 already
    // established (see idempotency.ts), not a second mechanism. Keyed on
    // this specific schedule run + order: the real risk this guards
    // against is a retried/duplicated dispatch call below (e.g. a Kafka
    // redelivery re-entering this whole function), never a double-charge
    // of recovery reasoning for the same breach.
    const enterpriseId = await resolveEnterpriseId(plantId);
    const eventId = `${scheduleRunId}:${productionOrderId}`;
    if (enterpriseId) {
      try {
        await prisma.idempotencyKey.create({
          data: { enterpriseId, key: eventId, operation: "disruption_promise_recovery", requestHash: "n/a", resultJson: {}, statusCode: 0 },
        });
      } catch (err) {
        if ((err as { code?: string }).code === "P2002") {
          logger.info("[PROMISE-IMPACT] recovery already dispatched for this event — skipping duplicate", { eventId });
          continue;
        }
        throw err;
      }
    }

    const disruptionEvent = {
      event_id: eventId,
      trace_id: traceId,
      disruption_type: disruptionType,
      plant_id: plantId,
      affected_resource_id: affectedResourceId ?? null,
      production_order_id: productionOrderId,
      product_id: productionOrder.productId,
      customer_name: productionOrder.salesOrder?.customer.name ?? null,
      requested_quantity: productionOrder.quantity,
      requested_date: productionOrder.salesOrder?.dueDate.toISOString() ?? originalPromisedDate.toISOString(),
      original_promised_date: originalPromisedDate.toISOString(),
      current_promised_date: currentPromisedDate?.toISOString() ?? null,
      occurred_at: new Date().toISOString(),
    };

    try {
      const response = await fetch(`${AGENT_ORCHESTRATOR_URL}/disruptions/evaluate`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-trace-id": traceId, ...internalServiceHeaders() },
        body: JSON.stringify(disruptionEvent),
      });
      if (!response.ok) {
        throw new Error(`agent-orchestrator returned ${response.status}`);
      }
      logger.info("[PROMISE-IMPACT] promise breach dispatched for agentic recovery", { eventId, productionOrderId });
    } catch (error) {
      // Stage 01 (Fail Loud, Fail Closed), applied here: the reschedule
      // already committed and is NOT undone by this failure — but a
      // failed dispatch must never be silently treated as "promise
      // handled." §13: if agent-orchestrator is unavailable, this is an
      // explicit, honest, recorded failure state, never a fabricated
      // success and never a consequential decision made on its behalf.
      logger.error("[PROMISE-IMPACT] failed to dispatch promise-breach event to agent-orchestrator", {
        eventId,
        productionOrderId,
        error: String(error),
      });
      await prisma.scheduleAuditLog.create({
        data: {
          entityType: "ProductionOrder",
          entityId: productionOrderId,
          after: {
            event: "PROMISE_RECOVERY_DISPATCH_FAILED",
            disruptionType,
            reason,
            scheduleRunId,
            originalPromisedDate: originalPromisedDate.toISOString(),
            currentPromisedDate: currentPromisedDate?.toISOString() ?? null,
            error: String(error),
          },
        },
      });
    }
  }
}

export type WhatIfOptions = { namespace: string; capacityAdjustments: CapacityAdjustment[] };

// Threaded through every capacity call and the two placement loops when
// running as a What-If dry run; null for a real run (default, unchanged
// behavior/call sites for every existing caller).
type DryRunCtx = { namespace: string; simulatedOperations: SimulatedOperation[]; capacityAdjustments: CapacityAdjustment[] };

export type { SchedulingMode };

// Stage 05 (Schedule Versioning): thrown before any work starts (before
// even the plant lock) when a caller supplies expectedScheduleVersion and
// it no longer matches the plant's real current PUBLISHED version — the
// caller computed/decided against a version that's already been
// superseded by someone else's run. A deterministic, typed rejection
// (index.ts maps this to a stable 409 shape), never a generic throw.
export class StaleScheduleVersionError extends Error {
  constructor(public readonly plantId: string, public readonly expectedVersion: number, public readonly currentVersion: number) {
    super(
      `Schedule for plant ${plantId} is at version ${currentVersion}, not the expected ${expectedVersion} — ` +
        `recompute against the current version and retry.`
    );
    this.name = "StaleScheduleVersionError";
  }
}

// Stage 05: thrown when the independent feasibility validator rejects a
// freshly-computed candidate before it's ever published — the plant's
// previous PUBLISHED schedule remains active untouched. Carries the
// validator's own concrete violations, not a vague "invalid".
export class ScheduleValidationError extends Error {
  constructor(public readonly plantId: string, public readonly violations: string[]) {
    super(`Independent feasibility validation rejected the computed schedule for plant ${plantId}: ${violations.join("; ")}`);
    this.name = "ScheduleValidationError";
  }
}

// Real ScheduleAuditLog wiring (Phase 6, agreed with the user) — the model
// already existed with exactly this before/after shape but nothing ever
// wrote to it, and the real reschedule path below hard-deletes the "before"
// state, so it has to be captured going forward, not reconstructed after
// the fact. Best-effort by design: a logging failure must never break a
// real reschedule, matching this session's established pattern for every
// other non-critical side write.
type ReleasedOpSnapshot = {
  scheduledStart: Date;
  scheduledEnd: Date;
  machineId: string | null;
  operatorId: string | null;
  reason: string;
  productionOrderId: string;
};

async function recordScheduleAudit(entityId: string, before: Prisma.InputJsonValue | null, after: Prisma.InputJsonValue | null) {
  try {
    await prisma.scheduleAuditLog.create({ data: { entityType: "ScheduledOperation", entityId, before: before ?? undefined, after: after ?? undefined } });
  } catch (error) {
    logger.warn("Failed to write ScheduleAuditLog row", { entityId, error: String(error) });
  }
}

// §6, the 11-step pipeline, run against one plant at a time. `whatIf`, when
// passed, runs the identical placement logic (same modes, same constraints)
// against a scratch capacity namespace instead of real Redis buckets and
// collects placements in memory instead of writing to Postgres — see
// DryRunCtx and the What-If-specific branches below.
export async function runSchedulingPipeline(
  plantId: string,
  scope: "ALL" | "AFFECTED" | "SINGLE" = "ALL",
  mode: SchedulingMode = "FORWARD",
  whatIf?: WhatIfOptions,
  // Real SINGLE/AFFECTED scoping (agreed with the user) — see
  // resolveScopedOrderIds's own doc comment for exactly what SINGLE and
  // AFFECTED mean. Left undefined (every Kafka-triggered autoReschedule
  // call — event-driven disruption triggers have no single target order
  // to seed from), AFFECTED/SINGLE behave as ALL, same as always; that's
  // a deliberate, unchanged fallback for those callers, not a partial fix.
  seedProductionOrderId?: string,
  // Real Recovery audit trail (Phase 6, agreed with the user) — a
  // human-readable cause, threaded into the real ScheduleAuditLog rows
  // written below. Purely additive/observability: no caller is required
  // to pass it, and omitting it changes nothing about what gets scheduled.
  reason?: string,
  // Phase 2 test-only override (agreed with the user) — no production
  // caller passes this; every real call gets the real PLANNING_HORIZON_DAYS/
  // EXTENDED_HORIZON_DAYS. Exists purely so the extended-horizon retry can
  // be tested with small, fast horizons instead of realistically
  // saturating ~91 days of real Redis capacity buckets (≈9,600 15-minute
  // buckets) just to prove the same two-attempt logic a 2-vs-5-day horizon
  // exercises identically and in milliseconds.
  horizonOverrideDays?: { normal: number; extended: number },
  // Stage 05 (optimistic concurrency, §3): when a caller supplies this,
  // the run is rejected with StaleScheduleVersionError BEFORE anything
  // else happens (before the plant lock, before any write) unless it
  // matches the plant's real current PUBLISHED version. Optional and
  // additive — every existing caller (Kafka autoReschedule, the Manual
  // Reschedule route, What-If) omits it and behaves exactly as before,
  // since the plant lock already serializes real runs for one plant; this
  // is for a caller that read a version, decided to act on it, and wants
  // that compare-and-swap enforced explicitly rather than merely implied.
  expectedScheduleVersion?: number
): Promise<PipelineResult> {
  const planningHorizonDays = horizonOverrideDays?.normal ?? PLANNING_HORIZON_DAYS;
  const extendedHorizonDays = horizonOverrideDays?.extended ?? EXTENDED_HORIZON_DAYS;
  const dryRunCtx: DryRunCtx | null = whatIf
    ? { namespace: whatIf.namespace, simulatedOperations: [], capacityAdjustments: whatIf.capacityAdjustments }
    : null;

  // Stage 05 (§3 Stale Commit Protection) — the cheapest possible check,
  // deliberately done before the plant lock/ScheduleRun row/any write:
  // a stale caller should fail fast, not wait in line for a lock only to
  // be rejected afterward. Skipped for What-If (never publishes a
  // version at all, so "stale" has no meaning for it).
  const activeScheduleBefore = dryRunCtx
    ? null
    : await prisma.schedule.findFirst({ where: { plantId, status: "PUBLISHED" }, orderBy: { versionNumber: "desc" } });
  if (!dryRunCtx && expectedScheduleVersion !== undefined) {
    const currentVersion = activeScheduleBefore?.versionNumber ?? 0;
    if (currentVersion !== expectedScheduleVersion) {
      throw new StaleScheduleVersionError(plantId, expectedScheduleVersion, currentVersion);
    }
  }

  // Step 1: Run Initialisation — skipped for a dry run: no real schedule run
  // is happening, and a scratch-namespaced what-if shouldn't need to block
  // on (or be blocked by) a real run's exclusive plant lock.
  const lockToken = dryRunCtx ? null : await acquirePlantLock(plantId);
  if (!dryRunCtx && !lockToken) throw new Error("Another scheduling run is already in progress for this plant");

  // Real bug found live (agreed with the user, see acquirePlantLock's own
  // doc comment): without a heartbeat, a run processing several open
  // orders could legitimately outlive the lock's fixed TTL, letting a
  // second run start concurrently on the same plant and produce real
  // duplicate ScheduledOperation rows. Renewed on a timer well inside the
  // TTL for as long as this run is in flight; cleared in the finally
  // block below alongside the real release.
  const lockHeartbeat: ReturnType<typeof setInterval> | null =
    !dryRunCtx && lockToken
      ? setInterval(() => {
          renewPlantLock(plantId, lockToken).catch((error) =>
            logger.error("Plant lock renewal failed", { plantId, error: String(error) })
          );
        }, PLANT_LOCK_RENEWAL_INTERVAL_MS)
      : null;

  const run = dryRunCtx ? null : await prisma.scheduleRun.create({ data: { plantId, scope, status: "RUNNING" } });
  // Stage 05 (§1 Schedule Versioning): the candidate version this run is
  // building, created now — not at the end — so every placement made
  // below can be tagged with it as it's written, rather than retrofitted
  // after the fact. Nothing about this candidate is "the" schedule yet:
  // it only becomes active (status PUBLISHED) at the very end, and only
  // if the independent validator (§4) accepts it.
  const candidateSchedule = dryRunCtx
    ? null
    : await prisma.schedule.create({
        data: { plantId, versionNumber: (activeScheduleBefore?.versionNumber ?? 0) + 1, status: "DRAFT" },
      });
  // Stage 05: every id soft-superseded this run (Planning Time Fence
  // release, across every order processed) — accumulated here so a
  // validation failure at the end can compensate by un-superseding
  // exactly these rows, restoring the previous PUBLISHED version to
  // exactly its prior state.
  const supersededOperationIds: string[] = [];
  const startedAt = Date.now();
  let conflictsDetected = 0;
  let operationsScheduled = 0;

  try {
    // Real SINGLE/AFFECTED narrowing — resolved before the main order
    // query so it applies as a real `where` filter, not a post-hoc
    // discard. See resolveScopedOrderIds's own doc comment.
    const { scopedOrderIds, targetOrderId } = await resolveScopedOrderIds(plantId, scope, seedProductionOrderId);

    // Step 2: Order Collection & Sort — Priority Score + max-heap queue.
    // (A sorted array drained highest-first is behaviorally identical to
    // draining a max-heap for a one-shot batch run; no heap needed here.)
    const orders = await prisma.productionOrder.findMany({
      where: {
        plantId,
        status: { in: ["PLANNED", "RELEASED"] },
        ...(scopedOrderIds ? { id: { in: scopedOrderIds } } : {}),
      },
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
          // processingTimeMin is minutes PER UNIT (standard routing
          // semantics — SAP's own "base quantity" convention);
          // setupTimeMin is a one-time fixed cost per operation, not
          // scaled by quantity. A real bug found live: this used to
          // treat processingTimeMin as a flat per-order number
          // regardless of quantity, so a 30-unit order scheduled
          // identically to a 1-unit order.
          const durationMin = Math.ceil(op.processingTimeMin * order.quantity + op.setupTimeMin); // real bug found live: a fractional duration (e.g. 0.5 min/unit x 15 units = 7.5) broke Redis's integer-only capacity-bucket math — round up, never under-allocate
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
      // Real ScheduleAuditLog capture (Phase 6) — snapshot each released
      // op's real state BEFORE the delete below destroys it, keyed by its
      // real RoutingOperation id so the real replacement (created later in
      // this same order's placement, at one of three real create sites) can
      // be matched back to it for a real before/after row. Never touched
      // for a dry run (the delete itself is already skipped then).
      const releasedByRoutingOpId = new Map<string, ReleasedOpSnapshot>();
      const auditReason = reason ?? "Manual reschedule";
      if (!dryRunCtx && toRelease.length > 0) {
        const releaseIds = toRelease.map((o) => o.id);
        for (const old of toRelease) {
          if (old.routingOperationId) {
            releasedByRoutingOpId.set(old.routingOperationId, {
              scheduledStart: old.scheduledStart,
              scheduledEnd: old.scheduledEnd,
              machineId: old.machineId,
              operatorId: old.operatorId,
              reason: auditReason,
              productionOrderId: old.productionOrderId,
            });
          }
        }
        // Stage 05 (§1/§6 — no silent mutation, preserve history): this
        // used to hard-delete both rows. A rerun now soft-supersedes them
        // instead — the exact same rows stay in the table forever, just
        // excluded from "current" queries (supersededAt/state), so the
        // previous schedule version remains a complete, real, queryable
        // historical record instead of being destroyed the moment it's
        // replaced. Reuses ReservationState's existing, previously-never-
        // set RELEASED value — the GiST exclusion constraint is scoped to
        // state = 'COMMITTED', so this also removes it from that
        // constraint's concern automatically, with no new enum value.
        await prisma.resourceReservation.updateMany({ where: { scheduledOperationId: { in: releaseIds } }, data: { state: "RELEASED" } });
        await prisma.scheduledOperation.updateMany({ where: { id: { in: releaseIds } }, data: { supersededAt: new Date() } });
        supersededOperationIds.push(...releaseIds);
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

          // processingTimeMin is minutes PER UNIT (standard routing
          // semantics — SAP's own "base quantity" convention);
          // setupTimeMin is a one-time fixed cost per operation, not
          // scaled by quantity. A real bug found live: this used to
          // treat processingTimeMin as a flat per-order number
          // regardless of quantity, so a 30-unit order scheduled
          // identically to a 1-unit order.
          const durationMin = Math.ceil(op.processingTimeMin * order.quantity + op.setupTimeMin); // real bug found live: a fractional duration (e.g. 0.5 min/unit x 15 units = 7.5) broke Redis's integer-only capacity-bucket math — round up, never under-allocate
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
              // Real bug found live (agreed with the user) — see the
              // matching Forward-mode block's own comment: the create +
              // reserve pair must be atomic, or a reservation conflict
              // leaves a real orphaned ScheduledOperation row behind.
              const scheduledOp = await prisma.$transaction(async (tx) => {
                const created = await tx.scheduledOperation.create({
                  data: {
                    productionOrderId: order.id,
                    routingOperationId: op.id,
                    machineId: machine.id,
                    scheduledStart,
                    scheduledEnd,
                    status: "SCHEDULED",
                    scheduleVersionId: candidateSchedule!.id,
                  },
                });
                await tx.resourceReservation.create({
                  data: {
                    resourceType: "MACHINE",
                    machineId: machine.id,
                    scheduledOperationId: created.id,
                    startTime: scheduledStart,
                    endTime: scheduledEnd,
                    state: "COMMITTED",
                    scheduleVersionId: candidateSchedule!.id,
                  },
                });
                return created;
              });
              if (operators.length > 0) {
                await resolveAndAssignOperator(
                  scheduledOp.id,
                  { start: scheduledStart, end: scheduledEnd },
                  op.requiredSkillId,
                  op.minProficiency,
                  operators,
                  operatorShiftWindows,
                  candidateSchedule!.id
                );
              }
              const releasedSnapshot = releasedByRoutingOpId.get(op.id);
              if (releasedSnapshot) {
                releasedByRoutingOpId.delete(op.id);
                await recordScheduleAudit(
                  scheduledOp.id,
                  { ...releasedSnapshot, scheduledStart: releasedSnapshot.scheduledStart.toISOString(), scheduledEnd: releasedSnapshot.scheduledEnd.toISOString() },
                  { scheduledStart: scheduledStart.toISOString(), scheduledEnd: scheduledEnd.toISOString(), machineId: machine.id, reason: auditReason, productionOrderId: order.id }
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
              dryRunCtx,
              candidateSchedule?.id ?? null,
              releasedByRoutingOpId.get(op.id),
              auditReason
            );
            releasedByRoutingOpId.delete(op.id);
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
        // Phase 2 (agreed with the user): a real performance bug found live
        // — this order's operations (Cut/Prep, Assemble, Fasten, ...) very
        // often share the same handful of candidate machines, and without
        // this, EVERY operation's extended-horizon attempt re-ran the full
        // per-bucket initialization for EVERY one of those machines from
        // scratch — for a real ~182-day horizon that's ~17,500 sequential
        // Redis round-trips, repeated per machine, repeated per operation.
        // One order with 3 unplaceable operations across 7 candidate
        // machines took over 60 real seconds and hit a real timeout live.
        // Once a machine's extended-horizon buckets are initialized for
        // this run, they stay initialized (ensureBucketsInitialized itself
        // already skips buckets that exist) — so remembering "already done"
        // per machine, for the lifetime of this one order's placement,
        // turns 3x redundant full passes into 1.
        const extendedHorizonInitialized = new Set<string>();

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
          // processingTimeMin is minutes PER UNIT (standard routing
          // semantics — SAP's own "base quantity" convention);
          // setupTimeMin is a one-time fixed cost per operation, not
          // scaled by quantity. A real bug found live: this used to
          // treat processingTimeMin as a flat per-order number
          // regardless of quantity, so a 30-unit order scheduled
          // identically to a 1-unit order.
          const durationMin = Math.ceil(op.processingTimeMin * order.quantity + op.setupTimeMin); // real bug found live: a fractional duration (e.g. 0.5 min/unit x 15 units = 7.5) broke Redis's integer-only capacity-bucket math — round up, never under-allocate
          const workCenterMachines = withSyntheticMachines(op.workCenter.machines, op.workCenter.id, dryRunCtx);
          const eligibleMachines = workCenterMachines.filter((m) =>
            checkMachineCapability(m.capabilities, op.operation).feasible
          );
          // Phase 2 (agreed with the user): the full "search candidates on
          // this work center, then fall back to alternative work centers"
          // sequence, unchanged in substance from before — just wrapped in
          // a closure so it can be tried once at the normal horizon and,
          // only if that fully fails, once more at EXTENDED_HORIZON_DAYS.
          // consumeReleasedSnapshot is true only for the normal-horizon
          // attempt: the released-op audit snapshot (see releasedByRoutingOpId)
          // is a one-time-use "what this operation looked like before this
          // rerun" record, and the normal attempt is what would have
          // consumed it before this phase existed — the extended attempt is
          // new behavior layered on top, not a second consumer of it.
          async function attemptPlacement(horizonDays: number, consumeReleasedSnapshot: boolean): Promise<boolean> {
            const searchEnd = new Date(effectiveEarliestStart.getTime() + horizonDays * 86_400_000);

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
              // Real bug found live (agreed with the user): ensureBucketsInitialized's
              // span used to be just durationMin (the operation's own few
              // minutes), floored at MIN_LOOKAHEAD_BUCKETS (15 days) — fine
              // for the normal horizon, whose behavior this leaves exactly
              // unchanged, but the extended-horizon attempt searches out to
              // EXTENDED_HORIZON_DAYS (182 by default), and getAvailableWindows
              // only ever sees buckets that actually exist in the Redis
              // index — a bucket 100+ days out that nothing has ever touched
              // is invisible, not "open."
              //
              // Two real performance fixes found live, on top of the
              // correctness fix above (a first working version genuinely
              // took 60+ real seconds and hit a timeout):
              //   1. Only initialize the DELTA beyond the normal horizon
              //      (planningHorizonDays..horizonDays), not the whole
              //      range from "now" again — the normal attempt already
              //      covered day 0..planningHorizonDays for every candidate
              //      machine it tried.
              //   2. Once a machine's delta range is initialized for THIS
              //      order, don't redo it for this order's other operations
              //      (see extendedHorizonInitialized above) — real orders
              //      routinely have several operations sharing the same
              //      handful of candidate machines.
              const isExtendedAttempt = horizonDays !== planningHorizonDays;
              if (isExtendedAttempt) {
                if (!extendedHorizonInitialized.has(machine.id)) {
                  const deltaStart = new Date(effectiveEarliestStart.getTime() + planningHorizonDays * 86_400_000);
                  const deltaSpanMin = (horizonDays - planningHorizonDays) * 24 * 60;
                  await ensureBucketsInitialized(machine.id, deltaStart, deltaSpanMin, dryRunCtx?.namespace);
                  extendedHorizonInitialized.add(machine.id);
                }
              } else {
                await ensureBucketsInitialized(machine.id, effectiveEarliestStart, durationMin, dryRunCtx?.namespace);
              }
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
                  viaExtendedHorizon: horizonDays !== planningHorizonDays,
                });
                opEndTimes.set(op.id, scheduledEnd);
                operationsScheduled++;
                return true;
              }

              try {
                // Real bug found live (agreed with the user): these two
                // writes used to be separate top-level calls — when the
                // SECOND (the reservation, guarded by the real GiST
                // exclusion constraint) threw on a genuine conflict, the
                // FIRST (the ScheduledOperation row) had already committed
                // and was never rolled back. The catch block below just
                // moved on to the next candidate, leaving a real orphaned
                // row behind every time — exactly what produced duplicate
                // ScheduledOperation rows for one operation under real
                // contention (multiple orders racing for the same handful
                // of real machines). A single transaction makes the pair
                // atomic: a reservation conflict now rolls back the
                // ScheduledOperation insert too, so a failed candidate
                // leaves nothing behind, matching what this catch block's
                // own "trying next candidate" comment already assumed.
                const scheduledOp = await prisma.$transaction(async (tx) => {
                  const created = await tx.scheduledOperation.create({
                    data: {
                      productionOrderId: order.id,
                      routingOperationId: op.id,
                      machineId: machine.id,
                      scheduledStart,
                      scheduledEnd,
                      status: "SCHEDULED",
                      scheduleVersionId: candidateSchedule!.id,
                    },
                  });
                  // Step 9: Conflict Detection — the GiST exclusion constraint
                  // (verified separately against real Postgres) is what actually
                  // enforces "no two COMMITTED reservations overlap"; this insert
                  // either succeeds or throws, which is the post-pass check.
                  await tx.resourceReservation.create({
                    data: {
                      resourceType: "MACHINE",
                      machineId: machine.id,
                      scheduledOperationId: created.id,
                      startTime: scheduledStart,
                      endTime: scheduledEnd,
                      state: "COMMITTED",
                      scheduleVersionId: candidateSchedule!.id,
                    },
                  });
                  return created;
                });
                if (operators.length > 0) {
                  await resolveAndAssignOperator(
                    scheduledOp.id,
                    { start: scheduledStart, end: scheduledEnd },
                    op.requiredSkillId,
                    op.minProficiency,
                    operators,
                    operatorShiftWindows,
                    candidateSchedule!.id
                  );
                }
                if (consumeReleasedSnapshot) {
                  const releasedSnapshot = releasedByRoutingOpId.get(op.id);
                  if (releasedSnapshot) {
                    releasedByRoutingOpId.delete(op.id);
                    await recordScheduleAudit(
                      scheduledOp.id,
                      { ...releasedSnapshot, scheduledStart: releasedSnapshot.scheduledStart.toISOString(), scheduledEnd: releasedSnapshot.scheduledEnd.toISOString() },
                      { scheduledStart: scheduledStart.toISOString(), scheduledEnd: scheduledEnd.toISOString(), machineId: machine.id, reason: auditReason, productionOrderId: order.id }
                    );
                  }
                }
                opEndTimes.set(op.id, scheduledEnd);
                operationsScheduled++;
                return true;
              } catch (error) {
                conflictsDetected++;
                logger.warn("Reservation conflict detected, trying next machine/window", {
                  machineId: machine.id,
                  opId: op.id,
                  error: String(error),
                });
              }
            }

            const altSlot = await tryAlternativeWorkCenters(
              op,
              order.id,
              op.id,
              durationMin,
              effectiveEarliestStart,
              searchEnd,
              false,
              dryRunCtx,
              candidateSchedule?.id ?? null,
              consumeReleasedSnapshot ? releasedByRoutingOpId.get(op.id) : undefined,
              auditReason
            );
            if (consumeReleasedSnapshot) releasedByRoutingOpId.delete(op.id);
            if (altSlot) {
              conflictsDetected += altSlot.conflicts;
              operationsScheduled++;
              opEndTimes.set(op.id, altSlot.end);
              return true;
            }
            return false;
          }

          let placed = await attemptPlacement(planningHorizonDays, true);
          let placedViaExtendedHorizon = false;
          if (!placed) {
            placed = await attemptPlacement(extendedHorizonDays, false);
            placedViaExtendedHorizon = placed;
          }
          if (!placed) {
            logger.warn("Could not place operation within horizon (including extended lookahead)", {
              opId: op.id,
              orderId: order.id,
              extendedHorizonDays,
            });
            opEndTimes.set(op.id, effectiveEarliestStart);
          } else if (placedViaExtendedHorizon) {
            // Real run (not dry-run): simulatedOperations doesn't exist to
            // carry the viaExtendedHorizon flag here, but the real, committed
            // ScheduledOperation row is enough of a fact on its own for this
            // phase's scope — no caller of the committing path needs to
            // distinguish "placed normally" from "placed via extended
            // lookahead" today. The dry-run/what-if path above (what the
            // pre-approval planning preview actually uses) carries the flag
            // per-operation on dryRunCtx.simulatedOperations instead.
            logger.info("Operation placed via extended-horizon lookahead", { opId: op.id, orderId: order.id });
          }

          void cpmResults.get(op.id)?.isCritical; // critical-path flag available for reporting/UI
        }
      }

      // Real ScheduleAuditLog capture (Phase 6) — anything still left in
      // releasedByRoutingOpId was released above but never matched to a
      // real replacement (a genuine "couldn't place operation within
      // horizon" case, already logged above at its own site) — a real,
      // useful "this was scheduled, now it isn't" signal for the Recovery
      // page, recorded as a before-only row (no `after` — there isn't one).
      for (const [routingOpId, snapshot] of releasedByRoutingOpId) {
        await recordScheduleAudit(
          `unplaced:${order.id}:${routingOpId}`,
          { ...snapshot, scheduledStart: snapshot.scheduledStart.toISOString(), scheduledEnd: snapshot.scheduledEnd.toISOString() },
          null
        );
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
        scope,
        targetOrderId,
        scopedOrderIds: scopedOrderIds ?? undefined,
        simulatedOperations: dryRunCtx.simulatedOperations,
      };
    }

    // Step 10: Optimisation Pass — best-effort call to optimization-service;
    // this pipeline still produces a valid, conflict-free schedule without
    // it, so a down/not-yet-built optimizer degrades gracefully rather than
    // failing the whole run.
    await tryOptimizationPass(plantId);

    // Stage 05 (§4 Independent Feasibility Validator) — the candidate
    // built above is NOT trusted on the placement loop's own say-so. This
    // re-derives feasibility from the real rows just written (precedence,
    // overlap, machine eligibility, operator skill, shift/calendar
    // boundaries, reservation consistency, order dependencies) before it
    // is ever allowed to become the active schedule.
    const validation = await validateScheduleFeasibility(plantId);
    if (!validation.valid) {
      // Rejected: compensate exactly — restore whatever this run
      // soft-superseded back to active, and mark everything this
      // candidate wrote as dead-on-arrival, so the plant's previous
      // PUBLISHED schedule (if any) is left exactly as it was. Nothing is
      // deleted either way — the rejected candidate and its rows remain
      // real, inspectable history (Schedule.status = REJECTED), not
      // silently discarded.
      if (supersededOperationIds.length > 0) {
        await prisma.scheduledOperation.updateMany({ where: { id: { in: supersededOperationIds } }, data: { supersededAt: null } });
        await prisma.resourceReservation.updateMany({ where: { scheduledOperationId: { in: supersededOperationIds } }, data: { state: "COMMITTED" } });
      }
      await prisma.scheduledOperation.updateMany({ where: { scheduleVersionId: candidateSchedule!.id }, data: { supersededAt: new Date() } });
      await prisma.resourceReservation.updateMany({ where: { scheduleVersionId: candidateSchedule!.id }, data: { state: "RELEASED" } });
      await prisma.schedule.update({ where: { id: candidateSchedule!.id }, data: { status: "REJECTED" } });
      const failureReason = `VALIDATION_FAILED: ${validation.violations.join("; ")}`;
      await prisma.scheduleRun.update({
        where: { id: run!.id },
        data: { status: "FAILED", finishedAt: new Date(), durationMs: Date.now() - startedAt, failureReason },
      });
      throw new ScheduleValidationError(plantId, validation.violations);
    }

    // Step 11: Schedule Publishing — validated above, this candidate now
    // becomes the plant's one active schedule. The previous PUBLISHED
    // version (if any) is explicitly superseded in the same step, never
    // silently replaced — at most one PUBLISHED Schedule per plant holds
    // at all times.
    if (activeScheduleBefore) {
      await prisma.schedule.update({ where: { id: activeScheduleBefore.id }, data: { status: "SUPERSEDED", supersededAt: new Date() } });
    }
    const schedule = await prisma.schedule.update({ where: { id: candidateSchedule!.id }, data: { status: "PUBLISHED" } });
    const nextVersion = schedule.versionNumber;

    // Stage 01 HIGH-risk debt closure: the Schedule row above (the real,
    // already-computed output of this whole run — every ScheduledOperation
    // placed by Steps 1-9 already committed earlier) is genuinely done at
    // this point. Before this fix, a publish failure here was caught by
    // this function's own outer catch below, which marked the ScheduleRun
    // FAILED — actively wrong, since nothing about the scheduling run
    // itself failed, only the notification of its completion. publishTracked
    // never throws, so a sync failure no longer reaches that catch at all;
    // it's logged with full context, recorded on the real ScheduleAuditLog
    // table (reusing recordScheduleAudit's own table, not a new one) so the
    // failure is durably visible, and the run still finishes COMPLETED —
    // the one truthful status given what actually happened.
    const syncError = await publishTracked(
      TOPICS.SCHEDULE_PUBLISHED,
      { plantId, scheduleId: schedule.id, versionNumber: nextVersion },
      { operation: "schedulingPipeline.schedulePublished", entityId: schedule.id }
    );
    if (syncError) {
      logger.error("Downstream sync failed after commit — mes-integration's shop-floor dispatch log and notification-service's dashboard relay will NOT see this schedule version", {
        operation: syncError.operation,
        target: syncError.target,
        entityId: syncError.entityId,
        plantId,
        versionNumber: nextVersion,
        cause: String(syncError.cause),
      });
      try {
        await prisma.scheduleAuditLog.create({
          data: {
            entityType: "ScheduleRun",
            entityId: run!.id,
            after: {
              event: "SCHEDULE_PUBLISHED_SYNC_FAILED",
              scheduleId: schedule.id,
              versionNumber: nextVersion,
              error: syncError.message,
            },
          },
        });
      } catch (auditError) {
        // Same defensive shape as recordScheduleAudit itself — this is a
        // secondary record of an already-logged failure; its own failure
        // must never mask the real schedule result below.
        logger.warn("Failed to write ScheduleAuditLog row for a schedule-publish sync failure", {
          runId: run!.id, error: String(auditError),
        });
      }
    }

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
      scope,
      targetOrderId,
      scopedOrderIds: scopedOrderIds ?? undefined,
      ...(syncError ? { syncWarning: syncError.message } : {}),
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
    if (lockHeartbeat) clearInterval(lockHeartbeat);
    if (!dryRunCtx && lockToken) await releasePlantLock(plantId, lockToken);
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
    // receivedAt: null — same real fix as inventory-service's
    // checkShortagesForProduct (Phase 3): a received PO's quantity is now
    // real stock (qtyUnrestricted), so counting it here too would
    // double-count it.
    const inbound = await prisma.purchaseOrder.findMany({
      where: { productSku: line.componentId, confirmed: true, receivedAt: null, expectedDate: { gte: new Date() } },
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
// narrowWindowsToShifts/narrowWindowsToHolidays moved to
// packages/domain/src/constraint-engine.ts (Phase 2, real practical-capacity
// reporting) — pure relocation, imported from @aps/domain above, so the new
// Workload-graph capacity computation can reuse the exact same narrowing
// semantics real placement uses instead of a second, silently-diverging copy.

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
  operatorShiftWindows: Map<string, TimeWindow[] | null>,
  scheduleVersionId: string
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
      // Same atomicity fix as the machine placement loops above: without
      // a transaction, a reservation conflict here would still leave the
      // ScheduledOperation's operatorId pointing at an operator with no
      // real backing reservation.
      await prisma.$transaction(async (tx) => {
        await tx.scheduledOperation.update({ where: { id: scheduledOperationId }, data: { operatorId: operator.id } });
        await tx.resourceReservation.create({
          data: {
            resourceType: "OPERATOR",
            operatorId: operator.id,
            scheduledOperationId,
            startTime: window.start,
            endTime: window.end,
            state: "COMMITTED",
            scheduleVersionId,
          },
        });
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
  dryRunCtx: DryRunCtx | null = null,
  // Stage 05: the candidate version a real (non-dry-run) placement made
  // here gets tagged with — null for What-If, where this function
  // returns before ever reaching a real write anyway.
  scheduleVersionId: string | null = null,
  // Real ScheduleAuditLog capture (Phase 6) — the real "before" snapshot
  // for this routing operation, if a prior placement was just released for
  // it, so the alternate-work-center fallback path is audited exactly the
  // same as the two primary placement loops it backstops.
  releasedSnapshot?: ReleasedOpSnapshot,
  auditReason?: string
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
      // Real bug found live (agreed with the user) — same fix as the two
      // primary placement loops: create + reserve must be atomic, or a
      // reservation conflict leaves a real orphaned ScheduledOperation row
      // behind on this alternate-work-center fallback path too.
      const created = await prisma.$transaction(async (tx) => {
        const createdOp = await tx.scheduledOperation.create({
          data: {
            productionOrderId: orderId,
            routingOperationId,
            machineId: machine.id,
            scheduledStart: start,
            scheduledEnd: end,
            status: "SCHEDULED",
            scheduleVersionId,
          },
        });
        await tx.resourceReservation.create({
          data: {
            resourceType: "MACHINE",
            machineId: machine.id,
            scheduledOperationId: createdOp.id,
            startTime: start,
            endTime: end,
            state: "COMMITTED",
            scheduleVersionId,
          },
        });
        return createdOp;
      });
      if (releasedSnapshot) {
        await recordScheduleAudit(
          created.id,
          { ...releasedSnapshot, scheduledStart: releasedSnapshot.scheduledStart.toISOString(), scheduledEnd: releasedSnapshot.scheduledEnd.toISOString() },
          { scheduledStart: start.toISOString(), scheduledEnd: end.toISOString(), machineId: machine.id, reason: auditReason ?? releasedSnapshot.reason, productionOrderId: orderId }
        );
      }
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
      headers: { "content-type": "application/json", ...internalServiceHeaders() },
      body: JSON.stringify({ plantId }),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error(`optimization-service returned ${response.status}`);
    logger.info("Optimization pass completed", { plantId });
  } catch (error) {
    logger.warn("Optimization pass skipped (optimization-service unavailable)", { error: String(error) });
  }
}
