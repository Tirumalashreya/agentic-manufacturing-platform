"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  createProductionOrder,
  runSchedulingPipeline,
  fetchLeadTimePreview,
  runWhatIfSimulation,
  updateOperationStatus,
  completeOperation,
  createOperator,
  addOperatorSkill,
  addOperatorShift,
  createSkill,
  createShift,
  deleteOperator,
  reportMachineBreakdown,
  setMachineStatus,
  updateOrder,
  deleteOrder,
  setDemoTicker,
  fetchHolidayCalendars,
  createHolidayCalendar,
  addHoliday,
  fetchPublicHolidays,
  updatePlantCalendar,
  updateWorkCenterCalendar,
  type SchedulingMode,
  type CapacityAdjustment,
} from "@/lib/services";
import { importOperatorsWorkbook, type ImportSheetResult } from "@/lib/setup-import";
import { clearAllData } from "@/lib/clear-plant-data";
import { computeLatenessStatus, type LatenessStatus } from "@/lib/lateness";

// Manual status actions from the Gantt hover card — "Start" and "Block" are
// a simple status flip; "Complete" reuses the real MES completion path so
// deviation/analytics data gets populated the same way a real completion
// report would, not a shortcut that skips it.
export async function updateOperationStatusAction(operationId: string, status: "SCHEDULED" | "IN_PROGRESS" | "BLOCKED") {
  try {
    await updateOperationStatus(operationId, status);
    revalidatePath("/schedule");
    revalidatePath("/production-planning");
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function completeOperationAction(operationId: string, actualStart: string, actualEnd: string, quantity: number) {
  try {
    await completeOperation(operationId, actualStart, actualEnd, quantity);
    revalidatePath("/schedule");
    revalidatePath("/production-planning");
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function triggerSchedulingRunAction(plantId: string, mode: SchedulingMode = "FORWARD") {
  try {
    const result = await runSchedulingPipeline(plantId, mode);
    revalidatePath("/dashboard");
    revalidatePath("/production-planning");
    revalidatePath("/schedule");
    return { ok: true as const, result };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

// Mocked billing (explicit product decision — no real payment processor is
// wired up here): "upgrading" just flips Enterprise.tier directly.
export async function upgradeTierAction(tier: "STARTER" | "PRO" | "ENTERPRISE") {
  const session = await auth();
  if (!session?.user.enterpriseId) {
    return { ok: false as const, error: "Not signed in to an organization" };
  }
  await prisma.enterprise.update({
    where: { id: session.user.enterpriseId },
    data: { tier, trialEndsAt: null },
  });
  revalidatePath("/", "layout");
  return { ok: true as const };
}

// Lead-Time Scheduling preview — read-only rough-cut projection, no
// scheduling run is triggered and nothing is written.
export async function fetchLeadTimePreviewAction(plantId: string) {
  try {
    const result = await fetchLeadTimePreview(plantId);
    return { ok: true as const, result };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

export type LatenessSummary = Record<LatenessStatus, number>;

function summarize(orderEndTimes: Map<string, Date>, dueDates: Map<string, Date | null>): LatenessSummary {
  const summary: LatenessSummary = { LATE: 0, AT_RISK: 0, ON_TRACK: 0, NO_DUE_DATE: 0 };
  for (const [orderId, end] of orderEndTimes) {
    const status = computeLatenessStatus(end, dueDates.get(orderId) ?? null);
    summary[status]++;
  }
  return summary;
}

export type ScenarioDefinition = { name: string; mode: SchedulingMode; capacityAdjustments: CapacityAdjustment[] };
export type ScenarioResult = {
  name: string;
  after: LatenessSummary;
  operationsScheduled: number;
  conflictsDetected: number;
  error?: string;
};

// §17 "Advanced Simulation / What-If: planner defines 3 scenarios; system
// presents side-by-side KPI comparison" — runs the real scheduling engine
// against N hypothetical capacity adjustments (writes nothing — see
// runWhatIfSimulation, each scenario gets its own scratch Redis namespace so
// they can run concurrently without interfering) and compares every
// scenario's resulting per-order completion times against the SAME real
// current baseline, computed once, using the identical lateness
// classification the Gantt already shows — a direct, apples-to-apples
// "which scenario actually helps."
export async function runScenarioComparisonAction(plantId: string, scenarios: ScenarioDefinition[]) {
  try {
    const dueDates = new Map<string, Date | null>();
    const beforeEndTimes = new Map<string, Date>();

    const realOps = await prisma.scheduledOperation.findMany({
      where: { productionOrder: { plantId }, status: { in: ["SCHEDULED", "IN_PROGRESS"] } },
      select: {
        scheduledEnd: true,
        productionOrder: { select: { id: true, salesOrder: { select: { dueDate: true } } } },
      },
    });
    for (const op of realOps) {
      const orderId = op.productionOrder.id;
      dueDates.set(orderId, op.productionOrder.salesOrder?.dueDate ?? null);
      const existing = beforeEndTimes.get(orderId);
      if (!existing || op.scheduledEnd > existing) beforeEndTimes.set(orderId, op.scheduledEnd);
    }
    const baseline = summarize(beforeEndTimes, dueDates);

    const scenarioResults = await Promise.all(
      scenarios.map(async (scenario): Promise<ScenarioResult> => {
        try {
          const simulation = await runWhatIfSimulation(plantId, scenario.mode, scenario.capacityAdjustments);

          const afterEndTimes = new Map<string, Date>();
          const simulatedOrderIds = new Set(simulation.simulatedOperations.map((op) => op.productionOrderId));
          const missingDueDates = [...simulatedOrderIds].filter((id) => !dueDates.has(id));
          if (missingDueDates.length > 0) {
            const orders = await prisma.productionOrder.findMany({
              where: { id: { in: missingDueDates } },
              select: { id: true, salesOrder: { select: { dueDate: true } } },
            });
            for (const order of orders) dueDates.set(order.id, order.salesOrder?.dueDate ?? null);
          }
          for (const op of simulation.simulatedOperations) {
            const end = new Date(op.scheduledEnd);
            const existing = afterEndTimes.get(op.productionOrderId);
            if (!existing || end > existing) afterEndTimes.set(op.productionOrderId, end);
          }

          return {
            name: scenario.name,
            after: summarize(afterEndTimes, dueDates),
            operationsScheduled: simulation.operationsScheduled,
            conflictsDetected: simulation.conflictsDetected,
          };
        } catch (error) {
          return {
            name: scenario.name,
            after: { LATE: 0, AT_RISK: 0, ON_TRACK: 0, NO_DUE_DATE: 0 },
            operationsScheduled: 0,
            conflictsDetected: 0,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      })
    );

    return { ok: true as const, baseline, scenarios: scenarioResults };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function createOrderAction(input: {
  plantId: string;
  productId: string;
  routingId?: string;
  quantity: number;
}) {
  try {
    await createProductionOrder(input);
    revalidatePath("/orders");
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

// Real SAP-style calendar management, all additive (see services.ts's own
// doc comment on this group of functions). addHolidayAction resolves a
// calendar by name — creating it on first mention — rather than requiring
// the id, since the manual form only ever has a name to work with (same
// create-or-find pattern setup-import.ts's getOrCreateHolidayCalendar uses).
export async function addHolidayAction(input: { calendarName: string; description: string; day: number; month: number; year: number }) {
  try {
    const existing = await fetchHolidayCalendars();
    const calendar = existing.find((c) => c.name === input.calendarName) ?? (await createHolidayCalendar(input.calendarName));
    await addHoliday(calendar.id, { description: input.description, day: input.day, month: input.month, year: input.year });
    revalidatePath("/calendar");
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function fetchPublicHolidaysAction(input: { name: string; countryCode: string; year: number }) {
  try {
    const result = await fetchPublicHolidays(input.name, input.countryCode, input.year);
    revalidatePath("/calendar");
    return { ok: true as const, result };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function updatePlantCalendarSettingsAction(
  plantId: string,
  year: number,
  patch: { workingDaysOfWeek?: number[]; holidayCalendarId?: string | null }
) {
  try {
    await updatePlantCalendar(plantId, year, patch);
    revalidatePath("/calendar");
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function updateWorkCenterCalendarAction(
  workCenterId: string,
  patch: { workingDaysOfWeek?: number[]; holidayCalendarId?: string | null }
) {
  try {
    await updateWorkCenterCalendar(workCenterId, patch);
    revalidatePath("/calendar");
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

// Destructive, whole-system reset — used from the Import page so testing a
// fresh upload doesn't require a hand-run scratch script each time (see
// clear-plant-data.ts's doc comment for exactly what's wiped and why the
// order is safe).
export async function clearAllDataAction() {
  try {
    await clearAllData();
    revalidatePath("/", "layout");
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function deleteOrderAction(orderId: string) {
  try {
    await deleteOrder(orderId);
    revalidatePath("/orders");
    revalidatePath("/schedule");
    revalidatePath("/production-planning");
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function createOperatorAction(input: { employeeId: string; name: string; department?: string; employmentType: string }) {
  try {
    await createOperator(input);
    revalidatePath("/operators");
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function deleteOperatorAction(operatorId: string) {
  try {
    await deleteOperator(operatorId);
    revalidatePath("/operators");
    revalidatePath("/schedule");
    revalidatePath("/my-jobs");
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function addOperatorSkillAction(operatorId: string, skillId: string, proficiency: string, certifiedUntil?: string) {
  try {
    await addOperatorSkill(operatorId, skillId, proficiency, certifiedUntil);
    revalidatePath("/operators");
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function addOperatorShiftAction(operatorId: string, shiftId: string) {
  try {
    await addOperatorShift(operatorId, shiftId);
    revalidatePath("/operators");
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

// Disruption Simulator (Schedule page) — fires the SAME real events (§14)
// the automatic-rescheduling Kafka consumers react to, so the reschedule
// that follows is genuinely real, not a staged effect. revalidates
// /schedule so the planner sees the pipeline's response immediately.
export async function triggerMachineBreakdownAction(machineId: string, faultCode: string, durationMinutes: number) {
  try {
    await reportMachineBreakdown(machineId, faultCode, durationMinutes);
    revalidatePath("/schedule");
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function repairMachineAction(machineId: string) {
  try {
    await setMachineStatus(machineId, "AVAILABLE");
    revalidatePath("/schedule");
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function cancelOrderAction(orderId: string) {
  try {
    await updateOrder(orderId, { status: "CANCELLED" });
    revalidatePath("/schedule");
    revalidatePath("/orders");
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function changeOrderQuantityAction(orderId: string, quantity: number) {
  try {
    await updateOrder(orderId, { quantity });
    revalidatePath("/schedule");
    revalidatePath("/orders");
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function toggleDemoTickerAction(enabled: boolean) {
  try {
    const result = await setDemoTicker(enabled);
    revalidatePath("/schedule");
    return { ok: true as const, enabled: result.enabled };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function createSkillAction(name: string) {
  try {
    const skill = await createSkill(name);
    revalidatePath("/operators");
    return { ok: true as const, skill: skill as { id: string; name: string } };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function createShiftAction(input: { name: string; startTime: string; endTime: string; breakMinutes?: number; daysOfWeek: number[] }) {
  try {
    const shift = await createShift(input);
    revalidatePath("/operators");
    return { ok: true as const, shift: shift as { id: string; name: string } };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

// Bulk import scoped to just Shifts/Operators — a sibling of the general
// /import flow, not a redirect to it, since Operator/Shift aren't
// plant-scoped and this page has no plant selector. Any sheet in the file
// that isn't a Shift or Operator is reported as skipped, not imported.
export async function importOperatorsFileAction(
  formData: FormData
): Promise<
  | { ok: true; result: ImportSheetResult[]; skippedSheets: string[] }
  | { ok: false; error: string }
> {
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return { ok: false, error: "No file selected" };
  }
  if (!file.name.endsWith(".xlsx") && !file.name.endsWith(".csv")) {
    return { ok: false, error: "File must be a .xlsx workbook or a .csv file" };
  }
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const { result, skippedSheets } = await importOperatorsWorkbook(buffer, file.name);
    revalidatePath("/operators");
    return { ok: true, result, skippedSheets };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
