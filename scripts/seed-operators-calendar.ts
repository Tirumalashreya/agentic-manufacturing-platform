// One-off script: seeds real Operators/Skills/Shifts and a real
// FactoryCalendar/HolidayCalendar for PLANT-01, through the real service
// APIs (operator-service, calendar-service) — these endpoints already
// existed and were fully built, they just never had real data. Also wires
// requiredSkillId onto Cable Management Kit's routing operations so the
// scheduler's skill-matching becomes meaningful, not a no-op.
//
// Run once against a running operator-service (:4009), calendar-service
// (:4013), and machine-service (:4008):
//   npx tsx scripts/seed-operators-calendar.ts

const OPERATOR_SERVICE_URL = process.env.OPERATOR_SERVICE_URL ?? "http://localhost:4009";
const CALENDAR_SERVICE_URL = process.env.CALENDAR_SERVICE_URL ?? "http://localhost:4013";
const MACHINE_SERVICE_URL = process.env.MACHINE_SERVICE_URL ?? "http://localhost:4008";
const PLANT_CODE = "PLANT-01";

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function main() {
  const { prisma } = await import("../packages/domain/src/index");
  const plant = await prisma.plant.findUniqueOrThrow({ where: { code: PLANT_CODE } });

  // --- Skills, matching the two real work centers' actual operations ---
  const assemblySkill = await post<{ id: string }>(`${OPERATOR_SERVICE_URL}/skills`, { name: "Cable Assembly" });
  const inspectionSkill = await post<{ id: string }>(`${OPERATOR_SERVICE_URL}/skills`, { name: "Quality Inspection" });
  console.log("Skills:", { assemblySkill: assemblySkill.id, inspectionSkill: inspectionSkill.id });

  // --- Wire requiredSkillId onto the real routing operations so
  // skill-matching is meaningful, not a no-op (only routing-service can
  // create operations, but no service exposes an UPDATE for one -- this
  // is a direct, one-time correction of already-seeded master data, same
  // category as the processingTimeMin fix earlier). ---
  const assyOpsUpdated = await prisma.routingOperation.updateMany({
    where: { operation: { in: ["Cut/Prep Cable Body", "Assemble", "Fasten"] } },
    data: { requiredSkillId: assemblySkill.id, minProficiency: "STANDARD" },
  });
  const packOpsUpdated = await prisma.routingOperation.updateMany({
    where: { operation: "Pack/Inspect" },
    data: { requiredSkillId: inspectionSkill.id, minProficiency: "STANDARD" },
  });
  console.log("Routing operations wired to skills:", { assyOpsUpdated: assyOpsUpdated.count, packOpsUpdated: packOpsUpdated.count });

  // --- Day shift, Mon-Fri 09:00-17:00 ---
  const dayShift = await post<{ id: string }>(`${CALENDAR_SERVICE_URL}/shifts`, {
    name: "Day Shift", startTime: "09:00", endTime: "17:00", breakMinutes: 30, daysOfWeek: [1, 2, 3, 4, 5],
  });
  console.log("Shift:", dayShift.id);

  // --- Real operators, real skills, real shift assignment ---
  const roster: { employeeId: string; name: string; skillId: string }[] = [
    { employeeId: "EMP-101", name: "Arjun Mehta", skillId: assemblySkill.id },
    { employeeId: "EMP-102", name: "Priya Nair", skillId: assemblySkill.id },
    { employeeId: "EMP-103", name: "Rahul Verma", skillId: assemblySkill.id },
    { employeeId: "EMP-104", name: "Sneha Iyer", skillId: inspectionSkill.id },
  ];
  for (const person of roster) {
    const operator = await post<{ id: string }>(`${OPERATOR_SERVICE_URL}/operators`, {
      employeeId: person.employeeId, name: person.name, department: "Production", employmentType: "FULL_TIME",
    });
    await post(`${OPERATOR_SERVICE_URL}/operators/${operator.id}/skills`, { skillId: person.skillId, proficiency: "EXPERT" });
    await post(`${OPERATOR_SERVICE_URL}/operators/${operator.id}/shifts`, { shiftId: dayShift.id });
    console.log("Operator:", person.name, "->", operator.id);
  }

  // --- Real India public holidays for 2026, plant-wide working week ---
  // The free public-holiday API (date.nager.at) isn't reliably returning
  // 2026 India data yet -- falling back to entering the real, known
  // national holidays directly (still real dates, not fetched live; the
  // service's own framing already says real systems don't live-sync this
  // anyway -- it's meant to be curated).
  let holidayCalendarId: string;
  try {
    const holidayResult = await post<{ holidayCalendarId: string; holidaysCreated: number }>(
      `${CALENDAR_SERVICE_URL}/holiday-calendars/fetch-public`,
      { name: "India Public Holidays 2026", countryCode: "IN", year: 2026 }
    );
    holidayCalendarId = holidayResult.holidayCalendarId;
    console.log("Holiday calendar (fetched):", holidayCalendarId, "-", holidayResult.holidaysCreated, "holidays");
  } catch (err) {
    console.warn("Public holiday fetch failed, entering known national holidays manually:", err instanceof Error ? err.message : err);
    const holidayCalendar = await post<{ id: string }>(`${CALENDAR_SERVICE_URL}/holiday-calendars`, { name: "India Public Holidays 2026" });
    const knownHolidays = [
      { description: "Republic Day", day: 26, month: 1, year: 2026 },
      { description: "Holi", day: 3, month: 3, year: 2026 },
      { description: "Independence Day", day: 15, month: 8, year: 2026 },
      { description: "Gandhi Jayanti", day: 2, month: 10, year: 2026 },
      { description: "Diwali", day: 8, month: 11, year: 2026 },
      { description: "Christmas Day", day: 25, month: 12, year: 2026 },
    ];
    for (const h of knownHolidays) {
      await post(`${CALENDAR_SERVICE_URL}/holiday-calendars/${holidayCalendar.id}/holidays`, h);
    }
    holidayCalendarId = holidayCalendar.id;
    console.log("Holiday calendar (manual):", holidayCalendarId, "-", knownHolidays.length, "holidays");
  }

  await post(`${CALENDAR_SERVICE_URL}/calendars`, {
    plantId: plant.id, year: 2026, timezone: "Asia/Kolkata",
    workingDaysOfWeek: [1, 2, 3, 4, 5], holidayCalendarId,
  });
  console.log("FactoryCalendar set for", PLANT_CODE, "2026: Mon-Fri, India public holidays observed");

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
