// Dependency-free string-similarity matcher for the bulk setup import's
// "freeform file" mode — no AI model call available in this environment (no
// Anthropic/OpenAI key configured), so column/sheet identification is a
// heuristic guess, not real understanding. That's exactly why the import UI
// requires a human review-and-confirm step before anything is written; this
// module only ever *proposes* a mapping.

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function bigrams(value: string): string[] {
  const result: string[] = [];
  for (let i = 0; i < value.length - 1; i++) result.push(value.slice(i, i + 2));
  return result;
}

// Dice's coefficient over character bigrams — simple, no dependency, and
// effective enough for short strings like spreadsheet column headers.
export function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na.length === 0 || nb.length === 0) return na === nb ? 1 : 0;
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return 0;

  const bigramsA = bigrams(na);
  const bigramsB = bigrams(nb);
  const remaining = new Map<string, number>();
  for (const bg of bigramsB) remaining.set(bg, (remaining.get(bg) ?? 0) + 1);

  let matches = 0;
  for (const bg of bigramsA) {
    const count = remaining.get(bg) ?? 0;
    if (count > 0) {
      matches++;
      remaining.set(bg, count - 1);
    }
  }
  return (2 * matches) / (bigramsA.length + bigramsB.length);
}

// Common abbreviations/aliases per target field — an exact hit here forces
// a high score even when bigram similarity alone would miss it (e.g. "Qty"
// vs "Quantity" share almost no bigrams despite being an obvious synonym).
//
// Entries keyed "EntityType.Field" take priority over a bare "Field" key —
// needed because "Name" means something different per entity (a machine's
// name vs a customer's name) and a synonym tuned for one leaked into the
// other with a real, confirmed consequence: "machinename" was added so
// Machine's "Name" field would match a "Machine Name" column, but because
// synonyms used to be keyed by field name alone, that same synonym also
// boosted Customer's "Name" field against "Machine ID" (they share the
// "Machine" prefix, so bigram similarity alone scores them 0.667) — real
// Machine Calendar/Capacity Load sheets (Machine ID + hours columns, no
// customer concept at all) were misclassified as Customer and 892 garbage
// rows landed in the real Customer table before this was caught.
const FIELD_SYNONYMS: Record<string, string[]> = {
  Code: ["code", "id", "wccode"],
  Type: ["type", "category", "kind"],
  EfficiencyFactor: ["efficiency", "efficiencyfactor", "eff"],
  "Machine.Name": ["name", "machinename", "resourcename", "resname"],
  "Customer.Name": ["name", "account", "client", "company", "customername"],
  // "station" (bare) was removed — it coincidentally scored 0.545 against a
  // "Status" column (both start with "stat"/similar letters), causing a
  // Machine sheet's Status column to get misread as WorkCenterCode.
  // "workstation" keeps the real synonym without that collision risk.
  WorkCenterCode: ["workcenter", "wc", "workcentercode", "resourcecode", "resource", "workstation"],
  RatedCapacity: ["capacity", "ratedcapacity", "maxcapacity", "caphr", "caphour", "throughput"],
  MinBatch: ["minbatch", "minlot", "minqty", "minimumbatch"],
  MaxBatch: ["maxbatch", "maxlot", "maxqty", "maximumbatch"],
  SetupTimeMin: ["setuptime", "setupmin", "setup", "changeovertime"],
  PowerKw: ["power", "powerkw", "kw", "kilowatts"],
  Capabilities: ["capabilities", "capability", "skills", "operations", "abilities"],
  SKU: ["sku", "productsku", "itemcode", "partnumber", "itemnumber"],
  Family: ["family", "productfamily", "category", "group"],
  UOM: ["uom", "unit", "unitofmeasure", "units"],
  LotSizeMin: ["lotsizemin", "minlotsize"],
  LotSizeMax: ["lotsizemax", "maxlotsize"],
  LeadTimeDays: ["leadtime", "leadtimedays", "leaddays"],
  BatchManaged: ["batchmanaged", "batch", "lottracked", "istracked"],
  DefaultSchedulingMode: ["schedulingmode", "defaultschedulingmode", "schedulingtype", "planningmode"],
  ProductSKU: ["productsku", "sku", "product", "itemcode", "partnumber", "partno", "itemnumber"],
  Version: ["version", "rev", "revision"],
  OpNumber: ["opnumber", "operationnumber", "seq", "sequence", "step", "opseq"],
  Operation: ["operation", "opname", "activity", "task", "process"],
  ProcessingTimeMin: ["processingtime", "processtime", "runtime", "cycletime", "duration"],
  OverlapPct: ["overlap", "overlappct", "overlappercent"],
  RequiresInspection: ["requiresinspection", "inspection", "qcrequired", "qc"],
  PredecessorOpNumbers: ["predecessor", "predecessors", "predecessoropnumbers", "prevop", "prereq"],
  AlternativeWorkCenterCodes: ["alternative", "altworkcenter", "altwc", "backupresource", "altresource"],
  Tier: ["tier", "customertier", "level", "grade"],
  SlaDays: ["sladays", "sla", "leadtimesla"],
  PenaltyPerDay: ["penalty", "penaltyperday", "latefee"],
  CustomerName: ["customername", "customer", "client", "clientname", "account"],
  RoutingVersion: ["routingversion", "version", "rev"],
  Quantity: ["quantity", "qty", "amount", "units", "orderqty"],
  DueDate: ["duedate", "needdate", "requireddate", "deadline", "delivery"],
  Priority: ["priority", "prio", "rank", "urgency"],
  Value: ["value", "ordervalue", "price", "revenue", "amount"],
  "Shift.Name": ["name", "shiftname"],
  StartTime: ["starttime", "shiftstart", "start"],
  EndTime: ["endtime", "shiftend", "end"],
  BreakMinutes: ["breakminutes", "breaktime", "breakmin", "break"],
  // "days" alone was too generic — it's a substring of "SlaDays" and
  // "LeadTimeDays", both real columns on unrelated entities (Customer,
  // Product), so a Customer sheet's SlaDays column scored 0.667 against
  // this synonym and helped misclassify the whole sheet as Shift.
  DaysOfWeek: ["daysofweek", "workdays", "weekdays", "shiftdays"],
  "Operator.Name": ["name", "operatorname", "employeename", "fullname"],
  EmployeeId: ["employeeid", "empid", "staffid", "employeenumber", "empno"],
  Department: ["department", "dept", "team"],
  EmploymentType: ["employmenttype", "emptype", "contracttype", "employmentstatus"],
  "Operator.Skills": ["skills", "skill", "competencies", "qualifications"],
  "Operator.Shifts": ["shifts", "shiftnames", "shift", "workschedule"],
  "Calendar.Date": ["date", "calendardate", "holidaydate"],
  IsWorking: ["isworking", "working", "workingday"],
  IsHoliday: ["isholiday", "holiday", "isholidy", "shutdown"],
  "Calendar.Label": ["label", "holidayname", "description", "reason"],
  HolidayCalendarName: ["holidaycalendarname", "holidaycalendar", "calendarname", "holidayset", "holidaygroup"],
  // Scoped to Holiday specifically — a bare "description"/"day"/"month"
  // synonym would be too generic (e.g. "day" is a substring of "DaysOfWeek")
  // and risk the same kind of cross-entity collision "days" and "station"
  // already caused elsewhere in this file.
  "Holiday.Description": ["description", "holidayname", "reason"],
  "Holiday.Day": ["day", "dayofmonth"],
  "Holiday.Month": ["month"],
  Year: ["year", "calendaryear", "fiscalyear"],
  "CalendarSettings.WorkingDaysOfWeek": ["workingdays", "workingdaysofweek", "weeklypattern", "workdays", "weekdays"],
  "WorkCenter.WorkingDaysOfWeek": ["workingdays", "workingdaysofweek", "weeklypattern", "workdays", "weekdays"],
};

function scoreFieldColumn(entityType: string, field: string, column: string): number {
  const directScore = similarity(field, column);
  const synonyms = FIELD_SYNONYMS[`${entityType}.${field}`] ?? FIELD_SYNONYMS[field] ?? [];
  let synonymScore = 0;
  const normalizedColumn = normalize(column);
  for (const synonym of synonyms) {
    if (normalizedColumn === synonym) return 1;
    const s = similarity(synonym, column);
    if (s > synonymScore) synonymScore = s;
  }
  return Math.max(directScore, synonymScore);
}

export type FieldMapping = { field: string; column: string | null; confidence: number };

// 0.3 was too permissive — confirmed via a real case: an "AssetTag" column
// (genuinely unrelated data) scored 0.36 against "SetupTimeMin" purely from
// incidental bigram overlap, got silently absorbed as that field's value
// instead of correctly falling through as an unmapped/"extra" column, and
// its nonsense value (a non-numeric asset tag) got silently coerced to 0 by
// num() at commit time with no error raised anywhere. Every genuine match
// observed across this importer's real-world test files has scored 0.6 or
// higher (synonym hits are usually 1.0); every confirmed-coincidental match
// has clustered at 0.3-0.53. 0.5 is the evidence-based line between them.
const MIN_CONFIDENCE = 0.5;

// Greedy global-best assignment: score every (field, column) pair, then
// assign highest-scoring pairs first, skipping any field/column already
// claimed — avoids two fields being assigned to the same column just
// because each field's independent best match happened to collide.
// entityType scopes synonym lookups (see FIELD_SYNONYMS) since the same
// field name can mean different things on different entities.
export function matchColumnsToFields(columns: string[], fields: string[], entityType: string): FieldMapping[] {
  const candidates: { field: string; column: string; score: number }[] = [];
  for (const field of fields) {
    for (const column of columns) {
      candidates.push({ field, column, score: scoreFieldColumn(entityType, field, column) });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  const usedColumns = new Set<string>();
  const usedFields = new Set<string>();
  const result: FieldMapping[] = [];

  for (const { field, column, score } of candidates) {
    if (usedFields.has(field) || usedColumns.has(column) || score < MIN_CONFIDENCE) continue;
    usedFields.add(field);
    usedColumns.add(column);
    result.push({ field, column, confidence: score });
  }
  for (const field of fields) {
    if (!usedFields.has(field)) result.push({ field, column: null, confidence: 0 });
  }
  return result;
}
