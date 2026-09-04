// Thin fetch wrappers around the backend services — reads for display use
// Prisma directly (this is a single internal app, not a public API surface),
// but anything that triggers real business logic (creating an order,
// kicking off a scheduling run) goes through the actual service's HTTP API
// rather than bypassing it, so the UI genuinely exercises the architecture.

const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL ?? "http://localhost:4001";
const SCHEDULING_SERVICE_URL = process.env.SCHEDULING_SERVICE_URL ?? "http://localhost:4005";
const ANALYTICS_SERVICE_URL = process.env.ANALYTICS_SERVICE_URL ?? "http://localhost:4017";
const REPORTING_SERVICE_URL = process.env.REPORTING_SERVICE_URL ?? "http://localhost:4016";
const MES_INTEGRATION_URL = process.env.MES_INTEGRATION_URL ?? "http://localhost:4019";
const MACHINE_SERVICE_URL = process.env.MACHINE_SERVICE_URL ?? "http://localhost:4008";
const OPERATOR_SERVICE_URL = process.env.OPERATOR_SERVICE_URL ?? "http://localhost:4009";
const CALENDAR_SERVICE_URL = process.env.CALENDAR_SERVICE_URL ?? "http://localhost:4013";

async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Request to ${url} failed with ${response.status}`);
  return data as T;
}

async function patchJSON<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Request to ${url} failed with ${response.status}`);
  return data as T;
}

async function deleteRequest(url: string): Promise<void> {
  const response = await fetch(url, { method: "DELETE", cache: "no-store" });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error ?? `Request to ${url} failed with ${response.status}`);
  }
}

export function createProductionOrder(input: {
  plantId: string;
  salesOrderId?: string;
  productId: string;
  routingId?: string;
  quantity: number;
  manualOverride?: number;
}) {
  return postJSON(`${ORDER_SERVICE_URL}/orders`, input);
}

export type { SchedulingMode } from "@aps/domain";
import type { SchedulingMode } from "@aps/domain";

export function runSchedulingPipeline(plantId: string, mode: SchedulingMode = "FORWARD") {
  return postJSON<{
    runId: string;
    ordersProcessed: number;
    operationsScheduled: number;
    conflictsDetected: number;
    scheduleVersion: number;
  }>(`${SCHEDULING_SERVICE_URL}/scheduling/runs`, { plantId, scope: "ALL", mode });
}

// Manual status transitions (Start / Block / revert to Scheduled) — a
// simple status-only update. Completing an operation goes through
// completeOperation below instead, since DONE needs real actual-vs-scheduled
// data, not just a status flip.
export function updateOperationStatus(operationId: string, status: "SCHEDULED" | "IN_PROGRESS" | "BLOCKED") {
  return patchJSON(`${SCHEDULING_SERVICE_URL}/scheduling/operations/${operationId}/status`, { status });
}

// Reuses the real MES completion-reporting endpoint (mes-integration) so a
// manually-completed operation gets the same deviation calculation and
// analytics forwarding a real shop-floor completion would — not a
// second, simplified "just set DONE" path. actualStart/actualEnd are real
// user input (what actually happened on the floor), not auto-derived from
// the schedule or the current clock — those can genuinely differ from the
// scheduled estimate, which is the whole point of tracking deviation.
export function completeOperation(operationId: string, actualStart: string, actualEnd: string, quantity: number) {
  return postJSON(`${MES_INTEGRATION_URL}/mes/completions`, {
    scheduledOperationId: operationId,
    actualStart,
    actualEnd,
    goodUnits: quantity,
    totalUnits: quantity,
  });
}

// Disruption Simulator (Schedule page): lets a planner trigger the same
// real events the auto-reschedule consumers react to (§14) from the UI
// instead of a terminal — a machine breakdown, an order cancellation, or a
// quantity change all fire the identical Kafka events real MES/ERP activity
// would, so the automatic reschedule that follows is genuinely real, not a
// staged demo effect.
export function reportMachineBreakdown(machineId: string, faultCode: string, durationMinutes: number) {
  return postJSON(`${MACHINE_SERVICE_URL}/machines/${machineId}/breakdown`, { faultCode, durationMinutes });
}

export function setMachineStatus(machineId: string, status: "AVAILABLE" | "RUNNING" | "DOWN" | "MAINTENANCE" | "OFFLINE") {
  return patchJSON(`${MACHINE_SERVICE_URL}/machines/${machineId}/status`, { status });
}

export function updateOrder(orderId: string, patch: { status?: string; quantity?: number }) {
  return patchJSON(`${ORDER_SERVICE_URL}/orders/${orderId}`, patch);
}

// Hard delete — removes the order and everything scheduled against it.
// Different from updateOrder({status: "CANCELLED"}), which keeps the order
// for history and only excludes it from future scheduling runs.
export function deleteOrder(orderId: string) {
  return deleteRequest(`${ORDER_SERVICE_URL}/orders/${orderId}`);
}

// Demo auto-progress ticker (see scheduling-service/src/index.ts) — the
// runtime toggle behind the Disruption Simulator panel's on/off switch, so
// presenters can turn the simulated shop floor on/off without restarting
// the service or setting an env var.
export async function fetchDemoTickerStatus() {
  const response = await fetch(`${SCHEDULING_SERVICE_URL}/scheduling/demo-ticker`, { cache: "no-store" });
  if (!response.ok) return { enabled: false, timeScale: 60 };
  return (await response.json()) as { enabled: boolean; timeScale: number };
}

export function setDemoTicker(enabled: boolean) {
  return patchJSON<{ enabled: boolean }>(`${SCHEDULING_SERVICE_URL}/scheduling/demo-ticker`, { enabled });
}

export type { CapacityAdjustment } from "@aps/domain";
import type { CapacityAdjustment } from "@aps/domain";

export type SimulatedOperation = {
  productionOrderId: string;
  routingOperationId: string;
  machineId: string;
  scheduledStart: string;
  scheduledEnd: string;
};

// What-If simulation: reuses the real scheduling engine against a scratch
// capacity namespace — writes nothing (see pipeline.ts's WhatIfOptions).
export function runWhatIfSimulation(
  plantId: string,
  mode: SchedulingMode,
  capacityAdjustments: CapacityAdjustment[]
) {
  return postJSON<{ operationsScheduled: number; conflictsDetected: number; simulatedOperations: SimulatedOperation[] }>(
    `${SCHEDULING_SERVICE_URL}/scheduling/what-if`,
    { plantId, scope: "ALL", mode, capacityAdjustments }
  );
}

export async function fetchBottleneck(from: string, to: string) {
  try {
    const response = await fetch(
      `${ANALYTICS_SERVICE_URL}/analytics/bottleneck?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      { cache: "no-store" }
    );
    if (!response.ok) return null;
    return (await response.json()) as { bottleneck: { machineId: string; loadPct: number } | null };
  } catch {
    return null; // analytics-service not running — the dashboard degrades gracefully rather than erroring
  }
}

export async function fetchDeviationAnalysis(plantId: string) {
  try {
    const response = await fetch(
      `${REPORTING_SERVICE_URL}/reports/deviation-analysis?plantId=${encodeURIComponent(plantId)}`,
      { cache: "no-store" }
    );
    if (!response.ok) return null;
    return (await response.json()) as {
      totalOrders: number;
      lateOrders: number;
      onTimePct: number | null;
      avgTardinessMin: number;
      productivityPct: number | null;
    };
  } catch {
    return null; // reporting-service not running — gauges degrade gracefully rather than erroring
  }
}

export async function fetchScrap(from: string, to: string) {
  try {
    const response = await fetch(
      `${ANALYTICS_SERVICE_URL}/analytics/scrap?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      { cache: "no-store" }
    );
    if (!response.ok) return null;
    return (await response.json()) as { scrapPct: number | null; scrapUnits: number; totalUnits: number };
  } catch {
    return null;
  }
}

export type LeadTimePreviewOrder = {
  productionOrderId: string;
  productSku: string;
  dueDate: string | null;
  projectedCompletion: string | null;
  operations: {
    routingOperationId: string;
    operation: string;
    projectedStart: string;
    projectedEnd: string;
    isCritical: boolean;
  }[];
};

export function fetchLeadTimePreview(plantId: string) {
  return fetch(`${SCHEDULING_SERVICE_URL}/scheduling/lead-time-preview?plantId=${encodeURIComponent(plantId)}`, {
    cache: "no-store",
  }).then(async (response) => {
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? `Request failed with ${response.status}`);
    return data as { orders: LeadTimePreviewOrder[] };
  });
}

export type MachineWorkload = { machineId: string; machineName: string; loadPct: number };

export async function fetchWorkload(plantId: string): Promise<MachineWorkload[]> {
  try {
    const response = await fetch(`${SCHEDULING_SERVICE_URL}/scheduling/workload?plantId=${encodeURIComponent(plantId)}`, {
      cache: "no-store",
    });
    if (!response.ok) return [];
    const data = (await response.json()) as { machines: MachineWorkload[] };
    return data.machines;
  } catch {
    return []; // scheduling-service not running — the graph degrades gracefully rather than erroring
  }
}

// Operator scheduling setup — a real Operator plus real Skill/Shift records
// let the pipeline's operator-resolution step (pipeline.ts) actually assign
// people, not just machines. All optional/additive: a plant with none of
// this configured schedules exactly as it did before this feature existed.
export function createOperator(input: { employeeId: string; name: string; department?: string; employmentType: string }) {
  return postJSON(`${OPERATOR_SERVICE_URL}/operators`, input);
}

export function addOperatorSkill(operatorId: string, skillId: string, proficiency: string, certifiedUntil?: string) {
  return postJSON(`${OPERATOR_SERVICE_URL}/operators/${operatorId}/skills`, { skillId, proficiency, certifiedUntil });
}

export function addOperatorShift(operatorId: string, shiftId: string) {
  return postJSON(`${OPERATOR_SERVICE_URL}/operators/${operatorId}/shifts`, { shiftId });
}

export function createSkill(name: string) {
  return postJSON(`${OPERATOR_SERVICE_URL}/skills`, { name });
}

// Hard delete — unassigns (not deletes) any ScheduledOperation they were on,
// reverting those to machine-only, same as if no operator had ever
// qualified for that slot. See operator-service's DELETE handler.
export function deleteOperator(operatorId: string) {
  return deleteRequest(`${OPERATOR_SERVICE_URL}/operators/${operatorId}`);
}

export function createShift(input: { name: string; startTime: string; endTime: string; breakMinutes?: number; daysOfWeek: number[] }) {
  return postJSON(`${CALENDAR_SERVICE_URL}/shifts`, input);
}

// Real SAP-style calendar management: reusable named HolidayCalendar
// templates (curated master data — see the Calendar page's own framing),
// a per-plant working pattern, and a per-Work-Center override of both
// (multi-level assignment, same as SAP's Plant/Work Center/Personnel Area
// levels). All additive — a plant/work center with none of this configured
// schedules exactly as it did before this feature existed.
export type HolidayCalendarSummary = {
  id: string;
  name: string;
  holidays: { id: string; description: string; day: number; month: number; year: number }[];
};

export async function fetchHolidayCalendars(): Promise<HolidayCalendarSummary[]> {
  const response = await fetch(`${CALENDAR_SERVICE_URL}/holiday-calendars`, { cache: "no-store" });
  if (!response.ok) return [];
  return (await response.json()) as HolidayCalendarSummary[];
}

export function createHolidayCalendar(name: string) {
  return postJSON<{ id: string; name: string }>(`${CALENDAR_SERVICE_URL}/holiday-calendars`, { name });
}

export function addHoliday(holidayCalendarId: string, input: { description: string; day: number; month: number; year: number }) {
  return postJSON(`${CALENDAR_SERVICE_URL}/holiday-calendars/${holidayCalendarId}/holidays`, input);
}

// One-time PRE-FILL convenience into the same editable HolidayCalendar this
// page manages by hand (real SAP doesn't live-sync holidays either) — uses
// a free, no-key public-holiday API, keyed by country + year.
export function fetchPublicHolidays(name: string, countryCode: string, year: number) {
  return postJSON<{ holidayCalendarId: string; name: string; holidaysFetched: number; holidaysCreated: number }>(
    `${CALENDAR_SERVICE_URL}/holiday-calendars/fetch-public`,
    { name, countryCode, year }
  );
}

export function updatePlantCalendar(plantId: string, year: number, patch: { workingDaysOfWeek?: number[]; holidayCalendarId?: string | null }) {
  return postJSON(`${CALENDAR_SERVICE_URL}/calendars`, { plantId, year, timezone: "UTC", ...patch });
}

export type WorkCenterSummary = {
  id: string;
  code: string;
  workingDaysOfWeek: number[];
  holidayCalendarId: string | null;
};

export async function fetchWorkCenters(plantId: string): Promise<WorkCenterSummary[]> {
  const response = await fetch(`${MACHINE_SERVICE_URL}/work-centers?plantId=${encodeURIComponent(plantId)}`, { cache: "no-store" });
  if (!response.ok) return [];
  return (await response.json()) as WorkCenterSummary[];
}

export function updateWorkCenterCalendar(workCenterId: string, patch: { workingDaysOfWeek?: number[]; holidayCalendarId?: string | null }) {
  return patchJSON(`${MACHINE_SERVICE_URL}/work-centers/${workCenterId}/calendar`, patch);
}
