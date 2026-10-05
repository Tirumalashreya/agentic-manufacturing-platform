import ExcelJS from "exceljs";
import JSZip from "jszip";
import { Readable } from "node:stream";
import { prisma } from "@/lib/prisma";
import { matchColumnsToFields, type FieldMapping } from "@/lib/fuzzy-match";
import { ENTITY_TYPES, type EntityType } from "@/lib/entity-types";
import { internalServiceHeaders } from "@aps/shared/serviceAuth";

export { ENTITY_TYPES, type EntityType };

// Real-world workbooks carry all kinds of worksheet-level relationship
// references we don't need — embedded charts/drawings, backgrounds, VML
// legacy drawings (comments/old form controls), hyperlinks, structured
// table refs. ExcelJS resolves every one of these by looking up
// `rels[model.thing.rId].Target` with no guard for a missing/dangling
// entry, so ANY of them throws the identical "Cannot read properties of
// undefined (reading 'Target')" if the relationship is missing — confirmed
// for real via a chart-bearing workbook (drawing) AND, separately, by
// reproducing the same crash through a dangling hyperlink relationship
// with no drawing involved at all. Stripping only <drawing> (the original,
// narrower fix) left every other case unhandled. Since we only ever need
// cell values, the robust fix is to remove every relationship-referencing
// element from each worksheet and blank out its .rels file entirely —
// nothing downstream needs any of them.
async function stripDrawingsAndCharts(buffer: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);

  for (const path of Object.keys(zip.files)) {
    if (
      path.startsWith("xl/drawings/") ||
      path.startsWith("xl/charts/") ||
      path.startsWith("xl/media/") ||
      path.startsWith("xl/embeddings/") ||
      path.startsWith("xl/ctrlProps/")
    ) {
      zip.remove(path);
    }
  }

  const sheetPaths = Object.keys(zip.files).filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path));
  for (const sheetPath of sheetPaths) {
    const file = zip.file(sheetPath);
    if (!file) continue;
    let xml = await file.async("string");
    xml = xml.replace(/<drawing[^/]*\/>/g, "");
    xml = xml.replace(/<legacyDrawing[^/]*\/>/g, "");
    xml = xml.replace(/<picture[^/]*\/>/g, "");
    xml = xml.replace(/<hyperlinks>[\s\S]*?<\/hyperlinks>/g, "");
    xml = xml.replace(/<tableParts[^>]*>[\s\S]*?<\/tableParts>/g, "");
    xml = xml.replace(/<oleObjects>[\s\S]*?<\/oleObjects>/g, "");
    xml = xml.replace(/<controls>[\s\S]*?<\/controls>/g, "");
    xml = xml.replace(/<mc:AlternateContent[^>]*>[\s\S]*?<\/mc:AlternateContent>/g, "");
    zip.file(sheetPath, xml);
  }

  // We removed every element on a worksheet that carries an r:id, so no
  // worksheet-level relationship is needed at all — blank the .rels file
  // outright instead of trying to enumerate every Type string that might
  // dangle (drawing/vmlDrawing/image/hyperlink/table/oleObject/control...).
  const relsPaths = Object.keys(zip.files).filter((path) => /^xl\/worksheets\/_rels\/sheet\d+\.xml\.rels$/.test(path));
  for (const relsPath of relsPaths) {
    zip.file(
      relsPath,
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>'
    );
  }

  return zip.generateAsync({ type: "nodebuffer" });
}

async function loadWorkbook(buffer: Buffer, isCsv: boolean): Promise<ExcelJS.Workbook> {
  if (isCsv) {
    // CSV has no drawings/charts/zip structure to crash on — read directly,
    // no retry path needed. Produces a single implicit worksheet, which
    // flows through analyzeSetupWorkbook exactly like a one-sheet workbook.
    const workbook = new ExcelJS.Workbook();
    await workbook.csv.read(Readable.from(buffer));
    return workbook;
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    return workbook;
  } catch {
    const stripped = await stripDrawingsAndCharts(buffer);
    const retryWorkbook = new ExcelJS.Workbook();
    await retryWorkbook.xlsx.load(stripped as unknown as ExcelJS.Buffer);
    return retryWorkbook;
  }
}

// Bulk plant-setup import, freeform version: the uploaded workbook can have
// any sheet names and any column names/order. analyzeSetupWorkbook() reads
// every sheet and *guesses* (via fuzzy-match.ts's heuristics — no AI model
// call available in this environment) which of the 7 known entity types
// each sheet represents and how its columns map to that entity's fields.
// Nothing is written during analysis. The UI shows those guesses for the
// user to confirm or correct; only commitSetupImport() — called with the
// human-confirmed mapping — actually creates anything, through the real
// service HTTP APIs (not direct Prisma writes) so the same side effects
// fire as when a user creates things one at a time (e.g.
// orders.production.created still publishes to Kafka).

const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL ?? "http://localhost:4001";
const ROUTING_SERVICE_URL = process.env.ROUTING_SERVICE_URL ?? "http://localhost:4002";
const MACHINE_SERVICE_URL = process.env.MACHINE_SERVICE_URL ?? "http://localhost:4008";
const OPERATOR_SERVICE_URL = process.env.OPERATOR_SERVICE_URL ?? "http://localhost:4009";
const CALENDAR_SERVICE_URL = process.env.CALENDAR_SERVICE_URL ?? "http://localhost:4013";

type EntityDef = { fields: string[]; requiredFields: string[] };

const ENTITY_DEFS: Record<EntityType, EntityDef> = {
  WorkCenter: {
    // WorkingDaysOfWeek/HolidayCalendarName are optional — a sheet with
    // neither column still imports exactly as before (see WorkCenter's own
    // doc comment in schema.prisma: empty array = inherit the plant's
    // FactoryCalendar pattern). Lets the same per-work-center calendar
    // override the Calendar page's manual form sets also be declared in
    // bulk, real SAP-style multi-level assignment (Plant, Work Center,
    // Personnel Area).
    fields: ["Code", "Type", "EfficiencyFactor", "WorkingDaysOfWeek", "HolidayCalendarName"],
    requiredFields: ["Code", "Type"],
  },
  Machine: {
    fields: ["Name", "WorkCenterCode", "Type", "RatedCapacity", "MinBatch", "MaxBatch", "SetupTimeMin", "PowerKw", "Capabilities", "Status"],
    // WorkCenterCode is NOT required — a file with no work-center concept at
    // all still imports (see getOrCreateDefaultWorkCenter): every machine it
    // declares lands in one auto-created "DEFAULT" work center rather than
    // failing the whole sheet. If the column exists but names a code that
    // isn't among the confirmed WorkCenters, that's still a real error (a
    // typo, not an absent concept) — only a genuinely missing/blank value
    // falls back.
    requiredFields: ["Name", "RatedCapacity"],
  },
  Product: {
    fields: ["SKU", "Family", "UOM", "LotSizeMin", "LotSizeMax", "LeadTimeDays", "BatchManaged", "DefaultSchedulingMode"],
    // Family/UOM default (see commit handler) rather than being required —
    // a simpler Part Master sheet (SKU + description-style fields only,
    // no category/unit-of-measure concept) still imports.
    requiredFields: ["SKU"],
  },
  Routing: { fields: ["ProductSKU", "Version"], requiredFields: ["ProductSKU", "Version"] },
  RoutingOperation: {
    fields: [
      "ProductSKU", "RoutingVersion", "OpNumber", "Operation", "WorkCenterCode",
      "ProcessingTimeMin", "SetupTimeMin", "OverlapPct", "RequiresInspection",
      "PredecessorOpNumbers", "AlternativeWorkCenterCodes",
    ],
    // Same WorkCenterCode fallback as Machine, above.
    requiredFields: ["ProductSKU", "RoutingVersion", "OpNumber", "Operation", "ProcessingTimeMin"],
  },
  Customer: { fields: ["Name", "Tier", "SlaDays", "PenaltyPerDay"], requiredFields: ["Name"] },
  Order: {
    fields: ["CustomerName", "ProductSKU", "RoutingVersion", "Quantity", "DueDate", "Priority", "Value"],
    // CustomerName is NOT required — same reasoning as WorkCenterCode: a
    // file with no customer concept at all still imports, every such order
    // lands under one auto-created "Unassigned" customer (see
    // getOrCreateDefaultCustomer) rather than failing the whole sheet.
    requiredFields: ["ProductSKU", "Quantity", "DueDate"],
  },
  Shift: {
    fields: ["Name", "StartTime", "EndTime", "BreakMinutes", "DaysOfWeek"],
    requiredFields: ["Name", "StartTime", "EndTime", "DaysOfWeek"],
  },
  // Skills and shift ASSIGNMENTS ride along on the Operator row itself
  // (Skills/Shifts CSV columns) rather than needing their own join sheets —
  // same fan-out pattern Machine already uses for its Capabilities column.
  // A Skill record is created on first mention rather than needing its own
  // catalog sheet, same reasoning: operators are a small, one-time setup
  // concern, not worth a 3rd sheet just to declare skill names up front.
  Operator: {
    fields: ["EmployeeId", "Name", "Department", "EmploymentType", "Skills", "Shifts"],
    requiredFields: ["EmployeeId", "Name"],
  },
  // One row per non-working day (a holiday or a factory shutdown day) — a
  // plant with no Calendar rows imported schedules exactly as before (see
  // pipeline.ts's narrowWindowsToHolidays guard). Ordinary working days
  // don't need a row at all; only exceptions to "normal" are declared here.
  Calendar: {
    fields: ["Date", "IsWorking", "IsHoliday", "Label"],
    requiredFields: ["Date"],
  },
  // A reusable, NOT plant-scoped named holiday set (e.g. "US Federal
  // Holidays 2026") — real systems (SAP's Holiday Calendar, for example)
  // maintain this once and let many plants' calendars point at the same
  // one, instead of every plant re-declaring the same national holidays.
  // HolidayCalendarName groups rows into that named set, created lazily on
  // first mention (same pattern as WorkCenterCode/CustomerName above).
  Holiday: {
    fields: ["HolidayCalendarName", "Description", "Day", "Month", "Year"],
    requiredFields: ["HolidayCalendarName", "Day", "Month", "Year"],
  },
  // The other half of the two-tier system: one row per plant per year
  // setting the weekly working-days pattern (which days repeat as
  // non-working every week, e.g. weekends) and which named Holiday Calendar
  // above applies. Not itself a list of dates — just the pattern + a
  // pointer, same as FactoryCalendar's own shape (see its doc comment in
  // schema.prisma).
  CalendarSettings: {
    fields: ["Year", "WorkingDaysOfWeek", "HolidayCalendarName"],
    requiredFields: ["Year"],
  },
};

const CLASSIFICATION_FLOOR = 0.4;

export type ImportRowError = { sheet: string; row: number; message: string };
export type ImportSheetResult = { sheet: string; imported: number; errors: ImportRowError[] };

async function postJSON(url: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...internalServiceHeaders() },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : `Request to ${url} failed with ${response.status}`);
  return data;
}

export type SheetRow = { rowNumber: number; data: Record<string, unknown> };

function sheetToRows(worksheet: ExcelJS.Worksheet): SheetRow[] {
  const headerRow = worksheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers[colNumber] = String(cell.value ?? "").trim();
  });

  const rows: SheetRow[] = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const data: Record<string, unknown> = {};
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const header = headers[colNumber];
      if (header) data[header] = cell.value;
    });
    if (Object.keys(data).length > 0) rows.push({ rowNumber, data });
  });
  return rows;
}

// ---------------------------------------------------------------------
// Phase 1: Analyze (read-only)
// ---------------------------------------------------------------------

export type SheetAnalysis = {
  sheetName: string;
  columns: string[];
  sampleRows: Record<string, unknown>[];
  rows: SheetRow[];
  guessedEntityType: EntityType | null;
  mappingsByEntityType: Record<EntityType, FieldMapping[]>;
};

export async function analyzeSetupWorkbook(buffer: Buffer, filename: string): Promise<SheetAnalysis[]> {
  const workbook = await loadWorkbook(buffer, filename.toLowerCase().endsWith(".csv"));

  const analyses: SheetAnalysis[] = [];
  for (const worksheet of workbook.worksheets) {
    let rows: SheetRow[];
    try {
      rows = sheetToRows(worksheet);
    } catch {
      // A single sheet with an unusual structure (e.g. a chart survived
      // stripping in some other form) shouldn't take down the whole
      // upload — skip just that sheet.
      continue;
    }
    if (rows.length === 0) continue;

    const columnSet = new Set<string>();
    for (const row of rows) for (const key of Object.keys(row.data)) columnSet.add(key);
    const columns = Array.from(columnSet);

    const mappingsByEntityType = {} as Record<EntityType, FieldMapping[]>;
    let bestEntityType: EntityType | null = null;
    let bestTotalScore = -1;
    let bestAvgScore = 0;
    // Fallback pass, only used if literally no entity type has every
    // required field mapped to a real column (see below) — keeps the old
    // best-effort behavior for that edge case rather than always returning
    // null.
    let fallbackEntityType: EntityType | null = null;
    let fallbackTotalScore = -1;
    let fallbackAvgScore = 0;

    for (const entityType of ENTITY_TYPES) {
      const def = ENTITY_DEFS[entityType];
      const mappings = matchColumnsToFields(columns, def.fields, entityType);
      mappingsByEntityType[entityType] = mappings;

      const requiredMappings = mappings.filter((m) => def.requiredFields.includes(m.field));
      const totalScore = requiredMappings.reduce((sum, m) => sum + m.confidence, 0);
      const avgScore = requiredMappings.length > 0 ? totalScore / requiredMappings.length : 0;
      // A required field with no matched column at all (not just a weak
      // match, an outright absence in the sheet) means every row would fail
      // to commit — that's a hard disqualifier, not something sqrt(avg)
      // should merely discount. Real bug this caught: a CalendarSettings
      // sheet (Year, WorkingDaysOfWeek, HolidayCalendarName — only "Year"
      // required) has no Day/Month columns at all, yet scored higher for
      // Holiday (HolidayCalendarName + Year both matched, avg 0.5 over 4
      // required fields) than for CalendarSettings itself (a single perfect
      // required match, avg 1.0 over 1 field) purely because Holiday's raw
      // sum (2.0) beat CalendarSettings's sum (1.0) enough to survive
      // sqrt(avg)'s penalty — every CalendarSettings row then failed to
      // commit with "Missing required field Day".
      const hasAllRequiredColumns = requiredMappings.every((m) => m.column !== null);

      // Rank by sum × sqrt(average), not sum alone and not sum × average.
      // Sum alone rewards "more evidence" (needed: a RoutingOperation-shaped
      // sheet with 6 matched fields must beat a Routing-shaped one with
      // only 2, even though both average 1.0) but let a weak single-field
      // match win any tie against genuinely-required-heavy entities:
      // Customer needs only 1 required field, so a sheet with a "Customer"
      // column tied 1.0 total against Machine's "Name" match even though
      // Machine only matched 1 of its 3 required fields (25 rows of orders
      // got imported as customers). Sum × average (squaring the average via
      // totalScore/count) fixed that tie but then over-corrected: a real
      // "Machine Master" sheet matching 2 of Machine's 3 required fields
      // well (Name=1.0, RatedCapacity=0.64, avg 0.55) still lost to
      // Customer's single perfect match (avg 1.0, but only one field of
      // evidence), because squaring a sub-1.0 average punishes entities
      // that simply declare more required fields. sqrt(average) softens
      // that penalty enough to let genuine multi-field evidence win while
      // still letting a strong single-field match beat a weak multi-field
      // one. Verified against all of: Steps sheet (RoutingOperation over
      // Routing), SalesOrders (Order over Routing), Accounts (Customer over
      // Machine), and Machine Master (Machine over Customer).
      const combinedScore = totalScore * Math.sqrt(avgScore);
      if (combinedScore > fallbackTotalScore + 1e-9) {
        fallbackTotalScore = combinedScore;
        fallbackEntityType = entityType;
        fallbackAvgScore = avgScore;
      }
      if (hasAllRequiredColumns && combinedScore > bestTotalScore + 1e-9) {
        bestTotalScore = combinedScore;
        bestEntityType = entityType;
        bestAvgScore = avgScore;
      }
    }

    if (bestEntityType === null) {
      bestEntityType = fallbackEntityType;
      bestAvgScore = fallbackAvgScore;
    }

    analyses.push({
      sheetName: worksheet.name,
      columns,
      sampleRows: rows.slice(0, 3).map((r) => r.data),
      rows,
      guessedEntityType: bestAvgScore >= CLASSIFICATION_FLOOR ? bestEntityType : null,
      mappingsByEntityType,
    });
  }

  return analyses;
}

// ---------------------------------------------------------------------
// Phase 2: Commit (writes, via human-confirmed mapping)
// ---------------------------------------------------------------------

export type ConfirmedSheet = {
  entityType: EntityType;
  rows: SheetRow[];
  fieldMapping: Record<string, string>; // our field name -> the row's actual column name
};

function fieldValue(row: SheetRow, fieldMapping: Record<string, string>, field: string): unknown {
  const column = fieldMapping[field];
  if (!column) return undefined;
  return row.data[column];
}

// Whatever the sheet has that the confirmed mapping didn't use for any of
// this entity's known fields — computed dynamically per row against the
// mapping, not against a static field list, so it stays correct if the
// mapping is edited. Display-only (see the `metadata` column's own
// doc-comment in schema.prisma): never read by scheduling logic.
function unmappedColumns(row: SheetRow, fieldMapping: Record<string, string>): Record<string, unknown> | undefined {
  const mappedColumns = new Set(Object.values(fieldMapping));
  const extra: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row.data)) {
    if (mappedColumns.has(column)) continue;
    if (value == null || value === "") continue;
    extra[column] = value instanceof Date ? value.toISOString() : value;
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}

function str(value: unknown): string | undefined {
  if (value == null) return undefined;
  const s = String(value).trim();
  return s.length > 0 ? s : undefined;
}

function num(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function bool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  const s = String(value ?? "").trim().toLowerCase();
  return s === "true" || s === "yes" || s === "1";
}

const MACHINE_STATUS_ALIASES: Record<string, string> = {
  active: "AVAILABLE",
  available: "AVAILABLE",
  idle: "AVAILABLE",
  running: "RUNNING",
  busy: "RUNNING",
  down: "DOWN",
  broken: "DOWN",
  maintenance: "MAINTENANCE",
  offline: "OFFLINE",
  inactive: "OFFLINE",
};

// Real-world files rarely use our exact enum spelling ("Active" instead of
// "AVAILABLE") — translated here rather than requiring an exact match, same
// reasoning as every other value-translation in this file (bool(), etc.).
// An unrecognized value is left for Prisma's own enum validation to reject
// with a clear error, rather than silently guessing.
function machineStatus(value: unknown): string | undefined {
  const s = str(value);
  if (!s) return undefined;
  return MACHINE_STATUS_ALIASES[s.toLowerCase()] ?? s.toUpperCase();
}

function csv(value: unknown): string[] {
  const s = str(value);
  if (!s) return [];
  return s.split(",").map((part) => part.trim()).filter(Boolean);
}

const DAY_NAMES: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

// Accepts either day names ("Mon,Tue,Wed") or raw 0-6 numbers
// (0=Sunday..6=Saturday, matching Shift.daysOfWeek) — names read naturally
// in a spreadsheet, numbers still work for anyone copying from the schema.
function parseDaysOfWeek(value: unknown): number[] {
  return csv(value)
    .map((token) => {
      const n = Number(token);
      if (Number.isInteger(n) && n >= 0 && n <= 6) return n;
      return DAY_NAMES[token.toLowerCase()];
    })
    .filter((n): n is number => n !== undefined);
}

function required<T>(value: T | undefined, field: string): T {
  if (value === undefined) throw new Error(`Missing required field "${field}" (check its column mapping)`);
  return value;
}

export async function commitSetupImport(plantId: string, confirmedSheets: ConfirmedSheet[]): Promise<ImportSheetResult[]> {
  const results: ImportSheetResult[] = [];

  const rowsByType = new Map<EntityType, { fieldMapping: Record<string, string>; rows: SheetRow[] }[]>();
  for (const sheet of confirmedSheets) {
    const existing = rowsByType.get(sheet.entityType) ?? [];
    existing.push({ fieldMapping: sheet.fieldMapping, rows: sheet.rows });
    rowsByType.set(sheet.entityType, existing);
  }

  async function processType(
    entityType: EntityType,
    handler: (row: SheetRow, fieldMapping: Record<string, string>) => Promise<void>
  ): Promise<void> {
    const groups = rowsByType.get(entityType) ?? [];
    const errors: ImportRowError[] = [];
    let imported = 0;
    for (const { fieldMapping, rows } of groups) {
      for (const row of rows) {
        try {
          await handler(row, fieldMapping);
          imported++;
        } catch (error) {
          errors.push({ sheet: entityType, row: row.rowNumber, message: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    if (imported > 0 || errors.length > 0) results.push({ sheet: entityType, imported, errors });
  }

  const workCenterIdByCode = new Map<string, string>();
  const productIdBySku = new Map<string, string>();
  const routingIdByKey = new Map<string, string>();
  const customerIdByName = new Map<string, string>();
  const routingOpIdByKey = new Map<string, string>();
  const routingOpRowsForDependencies: { row: SheetRow; fieldMapping: Record<string, string>; routingKey: string }[] = [];
  const shiftIdByName = new Map<string, string>();
  const skillIdByName = new Map<string, string>();
  const calendarIdByYear = new Map<number, string>();
  const holidayCalendarIdByName = new Map<string, string>();

  // Pre-populate cross-reference maps with rows that ALREADY exist (not just
  // ones created earlier in this same workbook) — otherwise a follow-up
  // import that only adds a couple of machines to a work center from a
  // previous import would wrongly report "Unknown WorkCenterCode", since
  // that code was never mentioned in *this* upload. A real gap caught during
  // verification: the first version only ever knew about rows from the
  // current file.
  const [existingWorkCenters, existingProducts, existingCustomers, existingRoutings, existingShifts, existingSkills, existingCalendars, existingHolidayCalendars] = await Promise.all([
    prisma.workCenter.findMany({ where: { plantId }, select: { id: true, code: true } }),
    prisma.product.findMany({ select: { id: true, sku: true } }),
    prisma.customer.findMany({ select: { id: true, name: true } }),
    prisma.routing.findMany({ select: { id: true, version: true, product: { select: { sku: true } } } }),
    prisma.shift.findMany({ select: { id: true, name: true } }),
    prisma.skill.findMany({ select: { id: true, name: true } }),
    prisma.factoryCalendar.findMany({ where: { plantId }, select: { id: true, year: true } }),
    // Not plant-scoped (see HolidayCalendar's doc comment) — every plant's
    // import shares the same lookup-by-name pool.
    prisma.holidayCalendar.findMany({ select: { id: true, name: true } }),
  ]);
  for (const wc of existingWorkCenters) workCenterIdByCode.set(wc.code, wc.id);
  for (const p of existingProducts) productIdBySku.set(p.sku, p.id);
  for (const c of existingCustomers) if (!customerIdByName.has(c.name)) customerIdByName.set(c.name, c.id);
  for (const r of existingRoutings) routingIdByKey.set(`${r.product.sku}::${r.version}`, r.id);
  for (const s of existingShifts) if (!shiftIdByName.has(s.name)) shiftIdByName.set(s.name, s.id);
  for (const s of existingSkills) skillIdByName.set(s.name, s.id);
  for (const c of existingCalendars) calendarIdByYear.set(c.year, c.id);
  for (const h of existingHolidayCalendars) holidayCalendarIdByName.set(h.name, h.id);

  const DEFAULT_WORK_CENTER_CODE = "DEFAULT";
  const DEFAULT_CUSTOMER_NAME = "Unassigned";
  let defaultWorkCenterId: string | undefined;
  let defaultCustomerId: string | undefined;

  // A file with no work-center concept at all (no column names anything
  // resembling one, anywhere) still imports — every machine/routing
  // operation that doesn't name a real WorkCenterCode lands in one
  // auto-created catch-all instead of failing the whole sheet. Created
  // lazily (only if actually needed) and once per import.
  async function getOrCreateDefaultWorkCenter(): Promise<string> {
    const existing = workCenterIdByCode.get(DEFAULT_WORK_CENTER_CODE);
    if (existing) return existing;
    if (defaultWorkCenterId) return defaultWorkCenterId;
    const workCenter = await postJSON(`${MACHINE_SERVICE_URL}/work-centers`, {
      plantId,
      code: DEFAULT_WORK_CENTER_CODE,
      type: "MACHINE",
      efficiencyFactor: 1,
    });
    defaultWorkCenterId = workCenter.id as string;
    workCenterIdByCode.set(DEFAULT_WORK_CENTER_CODE, defaultWorkCenterId);
    return defaultWorkCenterId;
  }

  // Same reasoning for Orders with no customer concept at all.
  async function getOrCreateDefaultCustomer(): Promise<string> {
    const existing = customerIdByName.get(DEFAULT_CUSTOMER_NAME);
    if (existing) return existing;
    if (defaultCustomerId) return defaultCustomerId;
    const customer = await postJSON(`${ORDER_SERVICE_URL}/customers`, { name: DEFAULT_CUSTOMER_NAME, tier: "STANDARD" });
    defaultCustomerId = customer.id as string;
    customerIdByName.set(DEFAULT_CUSTOMER_NAME, defaultCustomerId);
    return defaultCustomerId;
  }

  // 1. Work Centers
  await processType("WorkCenter", async (row, fieldMapping) => {
    const v = (field: string) => fieldValue(row, fieldMapping, field);
    const code = required(str(v("Code")), "Code");
    const workingDaysOfWeek = parseDaysOfWeek(v("WorkingDaysOfWeek"));
    const holidayCalendarName = str(v("HolidayCalendarName"));
    const holidayCalendarId = holidayCalendarName ? await getOrCreateHolidayCalendar(holidayCalendarName) : undefined;
    const workCenter = await postJSON(`${MACHINE_SERVICE_URL}/work-centers`, {
      plantId,
      code,
      type: required(str(v("Type")), "Type"),
      efficiencyFactor: num(v("EfficiencyFactor")) ?? 1,
      workingDaysOfWeek: workingDaysOfWeek.length > 0 ? workingDaysOfWeek : undefined,
      holidayCalendarId,
    });
    workCenterIdByCode.set(code, workCenter.id as string);
  });

  // 2. Machines (+ capabilities)
  await processType("Machine", async (row, fieldMapping) => {
    const v = (field: string) => fieldValue(row, fieldMapping, field);
    const workCenterCode = str(v("WorkCenterCode"));
    let workCenterId: string | undefined;
    if (workCenterCode) {
      workCenterId = workCenterIdByCode.get(workCenterCode);
      if (!workCenterId) throw new Error(`Unknown WorkCenterCode "${workCenterCode}" — check the Work Centers you confirmed`);
    } else {
      workCenterId = await getOrCreateDefaultWorkCenter();
    }

    const machine = await postJSON(`${MACHINE_SERVICE_URL}/machines`, {
      workCenterId,
      name: required(str(v("Name")), "Name"),
      type: str(v("Type")) ?? "GENERIC",
      ratedCapacity: required(num(v("RatedCapacity")), "RatedCapacity"),
      minBatch: num(v("MinBatch")) ?? 1,
      maxBatch: num(v("MaxBatch")),
      setupTimeMin: num(v("SetupTimeMin")) ?? 0,
      powerKw: num(v("PowerKw")) ?? 0,
      status: machineStatus(v("Status")),
      metadata: unmappedColumns(row, fieldMapping),
    });

    for (const operationType of csv(v("Capabilities"))) {
      await postJSON(`${MACHINE_SERVICE_URL}/machines/${machine.id}/capabilities`, { operationType });
    }
  });

  // 3. Products
  const VALID_SCHEDULING_MODES = ["FORWARD", "BACKWARD", "BOTTLENECK"];
  await processType("Product", async (row, fieldMapping) => {
    const v = (field: string) => fieldValue(row, fieldMapping, field);
    const sku = required(str(v("SKU")), "SKU");
    const modeRaw = str(v("DefaultSchedulingMode"))?.toUpperCase();
    if (modeRaw && !VALID_SCHEDULING_MODES.includes(modeRaw)) {
      throw new Error(`Invalid DefaultSchedulingMode "${modeRaw}" — must be FORWARD, BACKWARD, or BOTTLENECK`);
    }
    const product = await postJSON(`${ROUTING_SERVICE_URL}/products`, {
      sku,
      family: str(v("Family")) ?? "General",
      uom: str(v("UOM")) ?? "EA",
      lotSizeMin: num(v("LotSizeMin")) ?? 1,
      lotSizeMax: num(v("LotSizeMax")),
      leadTimeDays: num(v("LeadTimeDays")) ?? 0,
      batchManaged: bool(v("BatchManaged")),
      defaultSchedulingMode: modeRaw,
      metadata: unmappedColumns(row, fieldMapping),
    });
    productIdBySku.set(sku, product.id as string);
  });

  // 4. Routings
  await processType("Routing", async (row, fieldMapping) => {
    const v = (field: string) => fieldValue(row, fieldMapping, field);
    const sku = required(str(v("ProductSKU")), "ProductSKU");
    const version = required(str(v("Version")), "Version");
    const productId = productIdBySku.get(sku);
    if (!productId) throw new Error(`Unknown ProductSKU "${sku}" — check the Products you confirmed`);

    const routing = await postJSON(`${ROUTING_SERVICE_URL}/routings`, { productId, version });
    routingIdByKey.set(`${sku}::${version}`, routing.id as string);
  });

  // 5. Routing Operations (dependencies resolved in a second pass below)
  await processType("RoutingOperation", async (row, fieldMapping) => {
    const v = (field: string) => fieldValue(row, fieldMapping, field);
    const sku = required(str(v("ProductSKU")), "ProductSKU");
    const version = required(str(v("RoutingVersion")), "RoutingVersion");
    const routingKey = `${sku}::${version}`;
    const routingId = routingIdByKey.get(routingKey);
    if (!routingId) throw new Error(`Unknown Routing "${sku} v${version}" — check the Routings you confirmed`);

    const workCenterCode = str(v("WorkCenterCode"));
    let workCenterId: string | undefined;
    if (workCenterCode) {
      workCenterId = workCenterIdByCode.get(workCenterCode);
      if (!workCenterId) throw new Error(`Unknown WorkCenterCode "${workCenterCode}" — check the Work Centers you confirmed`);
    } else {
      workCenterId = await getOrCreateDefaultWorkCenter();
    }

    const altCodes = csv(v("AlternativeWorkCenterCodes"));
    const alternativeWorkCenterIds: string[] = [];
    for (const altCode of altCodes) {
      const altId = workCenterIdByCode.get(altCode);
      if (!altId) throw new Error(`Unknown AlternativeWorkCenterCode "${altCode}" — check the Work Centers you confirmed`);
      alternativeWorkCenterIds.push(altId);
    }

    const opNumber = required(num(v("OpNumber")), "OpNumber");
    const op = await postJSON(`${ROUTING_SERVICE_URL}/routings/${routingId}/operations`, {
      opNumber,
      operation: required(str(v("Operation")), "Operation"),
      workCenterId,
      processingTimeMin: required(num(v("ProcessingTimeMin")), "ProcessingTimeMin"),
      setupTimeMin: num(v("SetupTimeMin")) ?? 0,
      overlapPct: num(v("OverlapPct")) ?? 0,
      requiresInspection: bool(v("RequiresInspection")),
      alternativeWorkCenterIds,
    });

    routingOpIdByKey.set(`${routingKey}::${opNumber}`, op.id as string);
    routingOpRowsForDependencies.push({ row, fieldMapping, routingKey });
  });

  // Second pass: link predecessors, now that every op in the workbook exists.
  {
    const errors: ImportRowError[] = [];
    let imported = 0;
    for (const { row, fieldMapping, routingKey } of routingOpRowsForDependencies) {
      const opNumber = num(fieldValue(row, fieldMapping, "OpNumber"))!;
      const successorId = routingOpIdByKey.get(`${routingKey}::${opNumber}`)!;
      const predecessorOpNumbers = csv(fieldValue(row, fieldMapping, "PredecessorOpNumbers"));
      try {
        for (const predOpNumberStr of predecessorOpNumbers) {
          const predKey = `${routingKey}::${Number(predOpNumberStr)}`;
          const predecessorId = routingOpIdByKey.get(predKey);
          if (!predecessorId) throw new Error(`Unknown PredecessorOpNumber "${predOpNumberStr}" in routing "${routingKey}"`);
          await postJSON(`${ROUTING_SERVICE_URL}/operations/${successorId}/predecessors`, { predecessorId });
        }
        if (predecessorOpNumbers.length > 0) imported++;
      } catch (error) {
        errors.push({ sheet: "RoutingOperation (dependencies)", row: row.rowNumber, message: error instanceof Error ? error.message : String(error) });
      }
    }
    if (imported > 0 || errors.length > 0) {
      results.push({ sheet: "RoutingOperation (dependencies)", imported, errors });
    }
  }

  // 6. Customers
  await processType("Customer", async (row, fieldMapping) => {
    const v = (field: string) => fieldValue(row, fieldMapping, field);
    const name = required(str(v("Name")), "Name");
    const customer = await postJSON(`${ORDER_SERVICE_URL}/customers`, {
      name,
      tier: str(v("Tier")) ?? "STANDARD",
      slaDays: num(v("SlaDays")) ?? 14,
      penaltyPerDay: num(v("PenaltyPerDay")) ?? 0,
    });
    customerIdByName.set(name, customer.id as string);
  });

  // 7. Orders (Sales Order + Production Order)
  await processType("Order", async (row, fieldMapping) => {
    const v = (field: string) => fieldValue(row, fieldMapping, field);
    const customerName = str(v("CustomerName"));
    let customerId: string | undefined;
    if (customerName) {
      customerId = customerIdByName.get(customerName);
      if (!customerId) throw new Error(`Unknown CustomerName "${customerName}" — check the Customers you confirmed`);
    } else {
      customerId = await getOrCreateDefaultCustomer();
    }

    const sku = required(str(v("ProductSKU")), "ProductSKU");
    const productId = productIdBySku.get(sku);
    if (!productId) throw new Error(`Unknown ProductSKU "${sku}" — check the Products you confirmed`);

    const version = str(v("RoutingVersion"));
    let routingId: string | undefined;
    if (version) {
      routingId = routingIdByKey.get(`${sku}::${version}`);
      if (!routingId) throw new Error(`Unknown Routing "${sku} v${version}" — check the Routings you confirmed`);
    } else {
      const resolveResponse = await fetch(`${ROUTING_SERVICE_URL}/routings/resolve?productId=${encodeURIComponent(productId)}`, {
        headers: internalServiceHeaders(),
      });
      if (resolveResponse.ok) {
        const resolved = await resolveResponse.json();
        routingId = resolved.id as string;
      }
    }

    const dueDateRaw = v("DueDate");
    const dueDate = dueDateRaw instanceof Date ? dueDateRaw : new Date(required(str(dueDateRaw), "DueDate"));
    if (Number.isNaN(dueDate.getTime())) throw new Error(`Invalid DueDate "${dueDateRaw}"`);

    const salesOrder = await postJSON(`${ORDER_SERVICE_URL}/sales-orders`, {
      customerId,
      dueDate: dueDate.toISOString(),
      value: num(v("Value")) ?? 0,
      priority: num(v("Priority")) ?? 0,
    });

    await postJSON(`${ORDER_SERVICE_URL}/orders`, {
      plantId,
      salesOrderId: salesOrder.id,
      productId,
      routingId,
      quantity: required(num(v("Quantity")), "Quantity"),
      metadata: unmappedColumns(row, fieldMapping),
    });
  });

  // 8. Shifts (reusable shift definitions — operators and work centers both
  // reference these by name)
  await processType("Shift", async (row, fieldMapping) => {
    const v = (field: string) => fieldValue(row, fieldMapping, field);
    const name = required(str(v("Name")), "Name");
    const daysOfWeek = parseDaysOfWeek(v("DaysOfWeek"));
    if (daysOfWeek.length === 0) throw new Error(`DaysOfWeek must list at least one day (names like "Mon,Wed,Fri" or numbers 0-6)`);
    const shift = await postJSON(`${CALENDAR_SERVICE_URL}/shifts`, {
      name,
      startTime: required(str(v("StartTime")), "StartTime"),
      endTime: required(str(v("EndTime")), "EndTime"),
      breakMinutes: num(v("BreakMinutes")) ?? 0,
      daysOfWeek,
    });
    shiftIdByName.set(name, shift.id as string);
  });

  // 9. Operators (+ skills and shift assignments, fanned out from the same
  // row the same way Machine's Capabilities column fans out — see the
  // Operator entity's doc comment above).
  await processType("Operator", async (row, fieldMapping) => {
    const v = (field: string) => fieldValue(row, fieldMapping, field);
    const operator = await postJSON(`${OPERATOR_SERVICE_URL}/operators`, {
      employeeId: required(str(v("EmployeeId")), "EmployeeId"),
      name: required(str(v("Name")), "Name"),
      department: str(v("Department")),
      employmentType: str(v("EmploymentType")) ?? "FULL_TIME",
    });
    const operatorId = operator.id as string;

    for (const token of csv(v("Skills"))) {
      const [skillName, proficiency] = token.split(":").map((part) => part.trim());
      if (!skillName) continue;
      let skillId = skillIdByName.get(skillName);
      if (!skillId) {
        const skill = await postJSON(`${OPERATOR_SERVICE_URL}/skills`, { name: skillName });
        skillId = skill.id as string;
        skillIdByName.set(skillName, skillId);
      }
      await postJSON(`${OPERATOR_SERVICE_URL}/operators/${operatorId}/skills`, {
        skillId,
        proficiency: proficiency?.toUpperCase() || "STANDARD",
      });
    }

    for (const shiftName of csv(v("Shifts"))) {
      const shiftId = shiftIdByName.get(shiftName);
      if (!shiftId) throw new Error(`Unknown Shift "${shiftName}" — check the Shifts you confirmed`);
      await postJSON(`${OPERATOR_SERVICE_URL}/operators/${operatorId}/shifts`, { shiftId });
    }
  });

  // One FactoryCalendar per plant per year — created lazily on first
  // mention of a date in that year, then reused for every later row (this
  // import and any future one, via calendarIdByYear's pre-population above).
  // Calling the (now upsert) /calendars endpoint with no
  // workingDaysOfWeek/holidayCalendarId leaves those untouched if a
  // CalendarSettings row already created the same plant+year calendar.
  async function getOrCreateCalendarForYear(year: number): Promise<string> {
    const existing = calendarIdByYear.get(year);
    if (existing) return existing;
    const calendar = await postJSON(`${CALENDAR_SERVICE_URL}/calendars`, { plantId, year, timezone: "UTC" });
    const id = calendar.id as string;
    calendarIdByYear.set(year, id);
    return id;
  }

  // Reusable, NOT plant-scoped named holiday set — created lazily on first
  // mention of its name, same pattern as work centers/customers/shifts above.
  async function getOrCreateHolidayCalendar(name: string): Promise<string> {
    const existing = holidayCalendarIdByName.get(name);
    if (existing) return existing;
    const holidayCalendar = await postJSON(`${CALENDAR_SERVICE_URL}/holiday-calendars`, { name });
    const id = holidayCalendar.id as string;
    holidayCalendarIdByName.set(name, id);
    return id;
  }

  // 10. Holidays — rows in a reusable Holiday Calendar (see the Holiday
  // entity's doc comment above). Order relative to CalendarSettings doesn't
  // matter: whichever sheet mentions a HolidayCalendarName first creates it,
  // the other just reuses it by name.
  await processType("Holiday", async (row, fieldMapping) => {
    const v = (field: string) => fieldValue(row, fieldMapping, field);
    const calendarName = required(str(v("HolidayCalendarName")), "HolidayCalendarName");
    const holidayCalendarId = await getOrCreateHolidayCalendar(calendarName);
    await postJSON(`${CALENDAR_SERVICE_URL}/holiday-calendars/${holidayCalendarId}/holidays`, {
      description: str(v("Description")) ?? "Holiday",
      day: required(num(v("Day")), "Day"),
      month: required(num(v("Month")), "Month"),
      year: required(num(v("Year")), "Year"),
    });
  });

  // 11. Calendar Settings — the weekly working-days pattern + which named
  // Holiday Calendar this plant/year uses (see the CalendarSettings entity's
  // doc comment above). One row per year; upserts the same FactoryCalendar
  // the per-day Calendar sheet below also creates/reuses.
  await processType("CalendarSettings", async (row, fieldMapping) => {
    const v = (field: string) => fieldValue(row, fieldMapping, field);
    const year = required(num(v("Year")), "Year");
    const workingDaysOfWeek = parseDaysOfWeek(v("WorkingDaysOfWeek"));
    const holidayCalendarName = str(v("HolidayCalendarName"));
    const holidayCalendarId = holidayCalendarName ? await getOrCreateHolidayCalendar(holidayCalendarName) : undefined;

    const calendar = await postJSON(`${CALENDAR_SERVICE_URL}/calendars`, {
      plantId,
      year,
      timezone: "UTC",
      workingDaysOfWeek: workingDaysOfWeek.length > 0 ? workingDaysOfWeek : undefined,
      holidayCalendarId,
    });
    calendarIdByYear.set(year, calendar.id as string);
  });

  // 12. Calendar — one row per non-working day (holiday/shutdown); ordinary
  // working days need no row at all (see the Calendar entity's doc comment).
  await processType("Calendar", async (row, fieldMapping) => {
    const v = (field: string) => fieldValue(row, fieldMapping, field);
    const dateRaw = v("Date");
    const date = dateRaw instanceof Date ? dateRaw : new Date(required(str(dateRaw), "Date"));
    if (Number.isNaN(date.getTime())) throw new Error(`Invalid Date "${dateRaw}"`);

    const calendarId = await getOrCreateCalendarForYear(date.getUTCFullYear());
    await postJSON(`${CALENDAR_SERVICE_URL}/calendars/${calendarId}/days`, {
      date: date.toISOString(),
      isWorking: v("IsWorking") != null ? bool(v("IsWorking")) : false,
      isHoliday: v("IsHoliday") != null ? bool(v("IsHoliday")) : true,
      label: str(v("Label")),
    });
  });

  return results;
}

// ---------------------------------------------------------------------
// Template workbook (optional starting point, not a required schema)
// ---------------------------------------------------------------------

const TEMPLATE_SHEETS: { name: string; columns: string[]; example: (string | number | boolean)[] }[] = [
  {
    name: "WorkCenters",
    columns: ["Code", "Type", "EfficiencyFactor", "WorkingDaysOfWeek", "HolidayCalendarName"],
    example: ["WC-CNC", "MACHINE", 0.95, "Mon,Tue,Wed,Thu,Fri", ""],
  },
  {
    name: "Machines",
    columns: ["Name", "WorkCenterCode", "Type", "RatedCapacity", "MinBatch", "MaxBatch", "SetupTimeMin", "PowerKw", "Capabilities"],
    example: ["CNC Mill 1", "WC-CNC", "CNC_MILL", 10, 1, 50, 15, 7.5, "MILLING,DRILLING"],
  },
  {
    name: "Products",
    columns: ["SKU", "Family", "UOM", "LotSizeMin", "LotSizeMax", "LeadTimeDays", "BatchManaged", "DefaultSchedulingMode"],
    example: ["FG-10001", "Bracket Assembly", "EA", 10, 500, 3, false, "FORWARD"],
  },
  { name: "Routings", columns: ["ProductSKU", "Version"], example: ["FG-10001", "A"] },
  {
    name: "RoutingOperations",
    columns: [
      "ProductSKU", "RoutingVersion", "OpNumber", "Operation", "WorkCenterCode",
      "ProcessingTimeMin", "SetupTimeMin", "OverlapPct", "RequiresInspection",
      "PredecessorOpNumbers", "AlternativeWorkCenterCodes",
    ],
    example: ["FG-10001", "A", 10, "MILLING", "WC-CNC", 12, 15, 0, false, "", ""],
  },
  { name: "Customers", columns: ["Name", "Tier", "SlaDays", "PenaltyPerDay"], example: ["Acme Corp", "GOLD", 14, 100] },
  {
    name: "Orders",
    columns: ["CustomerName", "ProductSKU", "RoutingVersion", "Quantity", "DueDate", "Priority", "Value"],
    example: ["Acme Corp", "FG-10001", "A", 50, "2026-08-15", 1, 5000],
  },
  {
    name: "Shifts",
    columns: ["Name", "StartTime", "EndTime", "BreakMinutes", "DaysOfWeek"],
    example: ["Day Shift", "07:00", "15:00", 30, "Mon,Tue,Wed,Thu,Fri"],
  },
  {
    name: "Operators",
    columns: ["EmployeeId", "Name", "Department", "EmploymentType", "Skills", "Shifts"],
    example: ["EMP-001", "Alex Rivera", "Machining", "FULL_TIME", "CNC Operation:EXPERT", "Day Shift"],
  },
  {
    name: "Holidays",
    columns: ["HolidayCalendarName", "Description", "Day", "Month", "Year"],
    example: ["US Federal Holidays 2026", "Christmas Day", 25, 12, 2026],
  },
  {
    name: "CalendarSettings",
    columns: ["Year", "WorkingDaysOfWeek", "HolidayCalendarName"],
    example: [2026, "Mon,Tue,Wed,Thu,Fri", "US Federal Holidays 2026"],
  },
  {
    name: "Calendar",
    columns: ["Date", "IsWorking", "IsHoliday", "Label"],
    example: ["2026-11-27", false, true, "Unplanned Maintenance Shutdown"],
  },
];

export async function generateTemplateWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const sheet of TEMPLATE_SHEETS) {
    const worksheet = workbook.addWorksheet(sheet.name);
    worksheet.addRow(sheet.columns);
    worksheet.getRow(1).font = { bold: true };
    worksheet.addRow(sheet.example);
    worksheet.columns.forEach((col) => {
      col.width = 20;
    });
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// Operators/Shifts are not plant-scoped (see schema.prisma), so this is a
// deliberately narrower sibling of the general import flow rather than
// reusing it directly: no plantId is needed, and any sheet that isn't a
// Shift or Operator (e.g. someone uploads the full machine-shop workbook by
// mistake) is reported as skipped rather than silently importing unrelated
// master data from the /operators page.
const OPERATOR_IMPORT_TYPES: EntityType[] = ["Shift", "Operator"];

export async function importOperatorsWorkbook(
  buffer: Buffer,
  filename: string
): Promise<{ result: ImportSheetResult[]; skippedSheets: string[] }> {
  const sheets = await analyzeSetupWorkbook(buffer, filename);

  const confirmedSheets: ConfirmedSheet[] = [];
  const skippedSheets: string[] = [];
  for (const sheet of sheets) {
    if (!sheet.guessedEntityType || !OPERATOR_IMPORT_TYPES.includes(sheet.guessedEntityType)) {
      skippedSheets.push(sheet.sheetName);
      continue;
    }
    const fieldMapping: Record<string, string> = {};
    for (const mapping of sheet.mappingsByEntityType[sheet.guessedEntityType]) {
      if (mapping.column) fieldMapping[mapping.field] = mapping.column;
    }
    confirmedSheets.push({ entityType: sheet.guessedEntityType, rows: sheet.rows, fieldMapping });
  }

  // plantId is unused by the Shift/Operator handlers — commitSetupImport's
  // pre-population queries run unconditionally, but WorkCenter lookup
  // scoped to an empty plantId just returns nothing, harmlessly, since no
  // WorkCenter-dependent sheet is ever in confirmedSheets here.
  const result = await commitSetupImport("", confirmedSheets);
  return { result, skippedSheets };
}
