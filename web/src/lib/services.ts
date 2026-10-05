// Thin fetch wrappers around the backend services — reads for display use
// Prisma directly (this is a single internal app, not a public API surface),
// but anything that triggers real business logic (creating an order,
// kicking off a scheduling run) goes through the actual service's HTTP API
// rather than bypassing it, so the UI genuinely exercises the architecture.

import { internalServiceHeaders } from "@aps/shared/serviceAuth";

// Auth/Authz hardening, Phase 1 (Finding 1.1): every one of these backend
// services now requires the shared internal-service credential on every
// route. This file is the one place APS's server-side code calls them from
// (all Server Components/Route Handlers — never the browser), so wrapping
// the global fetch here, once, covers every call site below without
// hand-editing each one's headers individually.
function internalFetch(input: string, init: RequestInit = {}): Promise<Response> {
  return fetch(input, { ...init, headers: { ...init.headers, ...internalServiceHeaders() } });
}

const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL ?? "http://localhost:4001";
const SCHEDULING_SERVICE_URL = process.env.SCHEDULING_SERVICE_URL ?? "http://localhost:4005";
const ANALYTICS_SERVICE_URL = process.env.ANALYTICS_SERVICE_URL ?? "http://localhost:4017";
const REPORTING_SERVICE_URL = process.env.REPORTING_SERVICE_URL ?? "http://localhost:4016";
const MES_INTEGRATION_URL = process.env.MES_INTEGRATION_URL ?? "http://localhost:4019";
const MACHINE_SERVICE_URL = process.env.MACHINE_SERVICE_URL ?? "http://localhost:4008";
const OPERATOR_SERVICE_URL = process.env.OPERATOR_SERVICE_URL ?? "http://localhost:4009";
const CALENDAR_SERVICE_URL = process.env.CALENDAR_SERVICE_URL ?? "http://localhost:4013";
const INVENTORY_SERVICE_URL = process.env.INVENTORY_SERVICE_URL ?? "http://localhost:4010";

async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const response = await internalFetch(url, {
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
  const response = await internalFetch(url, {
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
  const response = await internalFetch(url, { method: "DELETE", cache: "no-store" });
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
// Real scrap/rejection capture (agreed with the user, extending the
// same real MES completion-reporting endpoint above): goodUnits is what
// the operator actually reports as good; rejectedUnits (defaulting to 0
// for the common case) is real input, not derived — an operator who
// doesn't touch the field reports zero scrap, honestly, rather than this
// silently guessing.
export function completeOperation(
  operationId: string,
  actualStart: string,
  actualEnd: string,
  quantity: number,
  rejectedUnits = 0,
  rejectionReason?: string
) {
  return postJSON(`${MES_INTEGRATION_URL}/mes/completions`, {
    scheduledOperationId: operationId,
    actualStart,
    actualEnd,
    goodUnits: Math.max(quantity - rejectedUnits, 0),
    totalUnits: quantity,
    rejectionReason: rejectedUnits > 0 ? rejectionReason || null : null,
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

// Real production-exception capture (agreed with the user, Phase 1
// completion) — the "why" behind a Block, not just the status flip.
// MACHINE_BREAKDOWN additionally reuses reportMachineBreakdown above (the
// real, already-tested disruption chain); every other type is persist +
// publish only, via scheduling-service's new route.
export type ExceptionType =
  | "MACHINE_BREAKDOWN"
  | "MATERIAL_SHORTAGE"
  | "OPERATOR_UNAVAILABLE"
  | "QUALITY_ISSUE"
  | "MAINTENANCE"
  | "BLOCKED"
  | "OTHER";

export function reportProductionException(operationId: string, type: ExceptionType, note?: string) {
  return postJSON(`${SCHEDULING_SERVICE_URL}/scheduling/operations/${operationId}/exceptions`, {
    type,
    note: note || null,
  });
}

export type ProductionExceptionSummary = {
  id: string;
  type: ExceptionType;
  note: string | null;
  reportedAt: string;
  productionOrderId: string;
  operation: string | null;
  machineName: string | null;
};

export async function fetchProductionExceptions(plantId: string): Promise<ProductionExceptionSummary[]> {
  try {
    const response = await internalFetch(
      `${SCHEDULING_SERVICE_URL}/scheduling/operations/exceptions?plantId=${encodeURIComponent(plantId)}`,
      { cache: "no-store" }
    );
    if (!response.ok) return [];
    const data = (await response.json()) as { items: ProductionExceptionSummary[] };
    return data.items;
  } catch {
    return []; // scheduling-service not running — the table degrades gracefully rather than erroring
  }
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
  const response = await internalFetch(`${SCHEDULING_SERVICE_URL}/scheduling/demo-ticker`, { cache: "no-store" });
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
    const response = await internalFetch(
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
    const response = await internalFetch(
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
    const response = await internalFetch(
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

// effectiveLoadPct/availabilityFactor (Phase 2, agreed with the user): real
// shift/holiday/break/maintenance/efficiency-adjusted practical capacity,
// replacing the raw 24/7-calendar-minutes loadPct as the primary figure a
// planner should act on. loadPct is kept (unchanged) for transparency.
export type MachineWorkload = { machineId: string; machineName: string; loadPct: number; effectiveLoadPct: number; availabilityFactor: number };

export async function fetchWorkload(plantId: string): Promise<MachineWorkload[]> {
  try {
    const response = await internalFetch(`${SCHEDULING_SERVICE_URL}/scheduling/workload?plantId=${encodeURIComponent(plantId)}`, {
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
  const response = await internalFetch(`${CALENDAR_SERVICE_URL}/holiday-calendars`, { cache: "no-store" });
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
  const response = await internalFetch(`${MACHINE_SERVICE_URL}/work-centers?plantId=${encodeURIComponent(plantId)}`, { cache: "no-store" });
  if (!response.ok) return [];
  return (await response.json()) as WorkCenterSummary[];
}

export function updateWorkCenterCalendar(workCenterId: string, patch: { workingDaysOfWeek?: number[]; holidayCalendarId?: string | null }) {
  return patchJSON(`${MACHINE_SERVICE_URL}/work-centers/${workCenterId}/calendar`, patch);
}

// Real Material Lifecycle (Phase 3, agreed with the user) — Vendor/Purchase
// Order/Inventory Movement all already existed as real, working
// inventory-service routes with zero UI in front of them (PO creation,
// vendor creation) or were net-new this round (receive, movements list).
// Plain Inventory reads stay direct Prisma in the page (this file's own
// header comment's convention), same as production-planning's ScheduledOperation
// table — these wrappers are only for the joined/business-logic routes.
export type Vendor = { id: string; name: string; leadTimeDays: number; reliabilityScore: number };

export async function fetchVendors(): Promise<Vendor[]> {
  const response = await internalFetch(`${INVENTORY_SERVICE_URL}/vendors`, { cache: "no-store" });
  if (!response.ok) return [];
  return (await response.json()) as Vendor[];
}

export function createVendor(input: { name: string; leadTimeDays?: number; reliabilityScore?: number }) {
  return postJSON<Vendor>(`${INVENTORY_SERVICE_URL}/vendors`, input);
}

// Real per-component vendor data (Phase 7, agreed with the user) — the
// only way real VendorProduct rows can exist; without this the new schema
// would be exactly the kind of orphaned data ChangeoverMatrix was before
// Phase 3 gave Materials a real way to populate data.
export function linkVendorProduct(vendorId: string, input: { productId: string; leadTimeDays: number; unitCost: number }) {
  return postJSON(`${INVENTORY_SERVICE_URL}/vendors/${vendorId}/products`, input);
}

export type PurchaseOrderSummary = {
  id: string;
  vendorName: string;
  productSku: string;
  quantity: number;
  expectedDate: string;
  confirmed: boolean;
  receivedAt: string | null;
};

export async function fetchPurchaseOrders(): Promise<PurchaseOrderSummary[]> {
  const response = await internalFetch(`${INVENTORY_SERVICE_URL}/purchase-orders`, { cache: "no-store" });
  if (!response.ok) return [];
  return (await response.json()) as PurchaseOrderSummary[];
}

// productId here is deliberately the component Product's id (matching
// inventory-service's own existing PurchaseOrder.productSku convention —
// see its create route's doc comment), not a real SKU string.
export function createPurchaseOrder(input: { vendorId: string; productId: string; quantity: number; expectedDate: string }) {
  return postJSON(`${INVENTORY_SERVICE_URL}/purchase-orders`, {
    vendorId: input.vendorId,
    productSku: input.productId,
    quantity: input.quantity,
    expectedDate: input.expectedDate,
  });
}

export function receivePurchaseOrder(purchaseOrderId: string, location: string) {
  return postJSON(`${INVENTORY_SERVICE_URL}/purchase-orders/${purchaseOrderId}/receive`, { location });
}

export type InventoryMovementSummary = {
  id: string;
  type: "GOODS_RECEIPT" | "GOODS_ISSUE";
  productSku: string;
  location: string;
  quantity: number;
  purchaseOrderId: string | null;
  productionOrderId: string | null;
  createdAt: string;
};

export async function fetchInventoryMovements(location: string): Promise<InventoryMovementSummary[]> {
  const response = await internalFetch(`${INVENTORY_SERVICE_URL}/inventory/movements?location=${encodeURIComponent(location)}`, {
    cache: "no-store",
  });
  if (!response.ok) return [];
  const data = (await response.json()) as { items: InventoryMovementSummary[] };
  return data.items;
}

// Real Quality (Phase 4, agreed with the user) — a standalone action, not
// folded into completeOperation, since inspection can genuinely happen
// after completion (or be redone after rework).
export type QcResult = "PASS" | "FAIL";

export function recordQualityInspection(operationId: string, result: QcResult, note?: string) {
  return postJSON(`${SCHEDULING_SERVICE_URL}/scheduling/operations/${operationId}/quality-inspections`, {
    result,
    note: note || null,
  });
}

export type QualityInspectionSummary = {
  id: string;
  result: QcResult;
  note: string | null;
  inspectedAt: string;
  productionOrderId: string;
  operation: string | null;
  machineName: string | null;
};

export async function fetchQualityInspections(plantId: string): Promise<QualityInspectionSummary[]> {
  try {
    const response = await internalFetch(
      `${SCHEDULING_SERVICE_URL}/scheduling/operations/quality-inspections?plantId=${encodeURIComponent(plantId)}`,
      { cache: "no-store" }
    );
    if (!response.ok) return [];
    const data = (await response.json()) as { items: QualityInspectionSummary[] };
    return data.items;
  } catch {
    return []; // scheduling-service not running — the table degrades gracefully rather than erroring
  }
}

// Real Monthly/Weekly/Daily Planning (Phase 5, agreed with the user) — real
// multi-week rollups, no new schema. "Daily" reuses /schedule's real Gantt
// rather than being rebuilt a third time; "Monthly" is a client-side
// re-aggregation of these same real weeks (PlanningRollup.tsx), not a
// separate server computation.
export type CapacityWeek = {
  weekStart: string;
  machines: { machineId: string; machineName: string; loadPct: number; effectiveLoadPct: number; availabilityFactor: number; effectiveCapacityMin: number; usedMin: number }[];
};

export async function fetchCapacityRollup(plantId: string, weeks = 13): Promise<CapacityWeek[]> {
  try {
    const response = await internalFetch(
      `${SCHEDULING_SERVICE_URL}/scheduling/capacity-rollup?plantId=${encodeURIComponent(plantId)}&weeks=${weeks}`,
      { cache: "no-store" }
    );
    if (!response.ok) return [];
    const data = (await response.json()) as { weeks: CapacityWeek[] };
    return data.weeks;
  } catch {
    return [];
  }
}

export type DemandWeek = { weekStart: string; totalQuantity: number; byProduct: { sku: string; quantity: number }[] };

export async function fetchDemandRollup(plantId: string, weeks = 13): Promise<DemandWeek[]> {
  try {
    const response = await internalFetch(
      `${SCHEDULING_SERVICE_URL}/scheduling/demand-rollup?plantId=${encodeURIComponent(plantId)}&weeks=${weeks}`,
      { cache: "no-store" }
    );
    if (!response.ok) return [];
    const data = (await response.json()) as { weeks: DemandWeek[] };
    return data.weeks;
  } catch {
    return [];
  }
}

export type DeviationWeek = {
  weekStart: string;
  totalOrders: number;
  lateOrders: number;
  onTimePct: number | null;
  avgTardinessMin: number;
  productivityPct: number | null;
  plannedMin: number;
  actualMin: number;
};

export async function fetchDeviationRollup(plantId: string, weeks = 13): Promise<DeviationWeek[]> {
  try {
    const response = await internalFetch(
      `${REPORTING_SERVICE_URL}/reports/deviation-rollup?plantId=${encodeURIComponent(plantId)}&weeks=${weeks}`,
      { cache: "no-store" }
    );
    if (!response.ok) return [];
    const data = (await response.json()) as { weeks: DeviationWeek[] };
    return data.weeks;
  } catch {
    return [];
  }
}

// Discoverability pass (agreed with the user): every fetcher below wraps a
// real endpoint that already existed and already worked before this round —
// none of them are new backend capability, only a new UI caller. Unlike the
// fetchers above (which silently degrade to [] / null on failure, an
// existing pattern this pass doesn't change), these distinguish "confirmed
// empty" from "couldn't reach the service" — a silently-empty Shortages
// panel telling a planner "nothing is short" when the real problem is
// inventory-service being down is exactly the kind of misleading state this
// pass exists to fix, so new callers get an honest result type instead.
export type FetchResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function getResult<T>(url: string): Promise<FetchResult<T>> {
  try {
    const response = await internalFetch(url, { cache: "no-store" });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      return { ok: false, error: body.error ?? `Service returned ${response.status}` };
    }
    return { ok: true, data: (await response.json()) as T };
  } catch {
    return { ok: false, error: "Service unavailable" };
  }
}

// POST /inventory/scan-shortages (real, Phase 1-era route — previously
// called only by inventory-service's own Kafka consumer on order creation,
// never by any page). A scan, not a stored list, so it's a POST even though
// this call site only ever reads the result.
export type ShortageLine = { productId: string; required: number; available: number };

export async function fetchShortages(): Promise<FetchResult<ShortageLine[]>> {
  try {
    const response = await internalFetch(`${INVENTORY_SERVICE_URL}/inventory/scan-shortages`, {
      method: "POST",
      cache: "no-store",
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      return { ok: false, error: body.error ?? `Service returned ${response.status}` };
    }
    const data = (await response.json()) as { shortages: ShortageLine[] };
    return { ok: true, data: data.shortages };
  } catch {
    return { ok: false, error: "Service unavailable" };
  }
}

// GET /vendors?productId= (real, Phase 7 — previously called only by the
// Python agent's tool layer for chat-driven vendor lookups, never by any
// page). Same route MaterialsPanel's unfiltered fetchVendors() above calls
// without the productId filter.
export type VendorProductLink = { id: string; name: string; leadTimeDays: number; unitCost: number };

export async function fetchVendorsForProduct(productId: string): Promise<VendorProductLink[]> {
  const response = await internalFetch(`${INVENTORY_SERVICE_URL}/vendors?productId=${encodeURIComponent(productId)}`, {
    cache: "no-store",
  });
  if (!response.ok) return [];
  return (await response.json()) as VendorProductLink[];
}

// GET /analytics/oee (real, all four legs computed — Availability from real
// resolved-downtime intervals, Performance/Quality/Overall from real
// actual-vs-scheduled and good/total units) — previously had zero callers
// anywhere in the product; the only place "OEE" appeared in this app was
// the marketing page's ad copy.
export type OeeResult = {
  availabilityPct: number | null;
  performancePct: number | null;
  qualityPct: number | null;
  oeeOverallPct: number | null;
};

export async function fetchOee(machineId: string, from: string, to: string): Promise<FetchResult<OeeResult>> {
  return getResult<OeeResult>(
    `${ANALYTICS_SERVICE_URL}/analytics/oee?machineId=${encodeURIComponent(machineId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
  );
}

// GET /scheduling/orders/:id/delay-explanation (real, Phase 8 — a
// deterministic composition of real ScheduleAuditLog/ProductionException/
// QualityInspection/deviationMinutes data, no LLM involved). Previously
// consumed only by the Python agent-orchestrator's chat capability, never
// by APS Platform's own UI — a planner had no way to see this without
// asking the chat.
export type DelayExplanation = {
  productionOrderId: string;
  salesOrderId: string | null;
  dueDate: string | null;
  latenessStatus: "LATE" | "AT_RISK" | "ON_TRACK" | "NO_DUE_DATE";
  operations: {
    id: string;
    operation: string | null;
    machineName: string | null;
    status: string;
    scheduledStart: string;
    scheduledEnd: string;
    actualEnd: string | null;
    deviationMinutes: number | null;
    qcHold: { blocked: boolean; reason: string | null } | null;
    recentExceptions: { type: string; note: string | null; reportedAt: string; resolvedAt: string | null }[];
  }[];
  auditHistory: { logTimestamp: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }[];
};

export async function fetchDelayExplanation(productionOrderId: string): Promise<FetchResult<DelayExplanation>> {
  return getResult<DelayExplanation>(`${SCHEDULING_SERVICE_URL}/scheduling/orders/${productionOrderId}/delay-explanation`);
}

// GET /scheduling/operations/:id/quality-hold-status (real, Phase 8 — the
// exact same checkQcHold gate the Start-status PATCH already runs as a side
// effect, exposed read-only). Previously consumed only by the Python
// agent's Quality Agent — a planner only ever experienced this as a
// rejected Start, never as something visible beforehand.
export async function fetchQcHoldStatus(scheduledOperationId: string): Promise<FetchResult<{ blocked: boolean; reason: string | null }>> {
  return getResult<{ blocked: boolean; reason: string | null }>(
    `${SCHEDULING_SERVICE_URL}/scheduling/operations/${scheduledOperationId}/quality-hold-status`
  );
}
