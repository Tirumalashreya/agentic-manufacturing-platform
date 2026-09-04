process.env.SERVICE_NAME = "calendar-service";

import { createApp, registerErrorHandler, logger } from "@aps/shared";
import { prisma } from "@aps/domain";

const app = createApp();
const PORT = Number(process.env.PORT ?? 4013);

// §11: "Calendar Service — Factory calendars, holidays, shift definitions,
// working periods — GET /calendar/working-periods"

app.post("/calendars", async (req, res) => {
  const { plantId, year, timezone, workingDaysOfWeek, holidayCalendarId } = req.body as {
    plantId: string;
    year: number;
    timezone: string;
    workingDaysOfWeek?: number[];
    holidayCalendarId?: string;
  };
  // Upsert, not create: a plant's Holidays/CalendarSettings sheets and its
  // per-day Calendar sheet can each mention the same plantId+year (the
  // @@unique constraint FactoryCalendar already has) in any order, and
  // whichever runs second must update the same row rather than fail on a
  // unique-constraint violation. Fields left undefined on this call (e.g.
  // the per-day sheet never sends workingDaysOfWeek/holidayCalendarId) are
  // simply not touched by `update` — Prisma treats an undefined property as
  // absent, not as "set to null".
  const calendar = await prisma.factoryCalendar.upsert({
    where: { plantId_year: { plantId, year } },
    create: { plantId, year, timezone, workingDaysOfWeek, holidayCalendarId },
    update: { workingDaysOfWeek, holidayCalendarId },
  });
  res.status(201).json(calendar);
});

app.post("/calendars/:id/days", async (req, res) => {
  const { date, isWorking, isHoliday, label } = req.body as { date: string; isWorking?: boolean; isHoliday?: boolean; label?: string };
  const day = await prisma.factoryCalendarDay.create({
    data: { calendarId: req.params.id, date: new Date(date), isWorking: isWorking ?? true, isHoliday: isHoliday ?? false, label },
  });
  res.status(201).json(day);
});

// Reusable, NOT plant-scoped holiday set (e.g. "US Federal Holidays
// 2026") — multiple plants' FactoryCalendar rows can point at the same
// one via holidayCalendarId instead of each re-declaring the same dates.
app.get("/holiday-calendars", async (_req, res) => {
  res.json(await prisma.holidayCalendar.findMany({ include: { holidays: true } }));
});

app.post("/holiday-calendars", async (req, res) => {
  const { name } = req.body as { name: string };
  const holidayCalendar = await prisma.holidayCalendar.create({ data: { name } });
  res.status(201).json(holidayCalendar);
});

app.post("/holiday-calendars/:id/holidays", async (req, res) => {
  const { description, day, month, year } = req.body as { description: string; day: number; month: number; year: number };
  const holiday = await prisma.holiday.create({
    data: { holidayCalendarId: req.params.id, description, day, month, year },
  });
  res.status(201).json(holiday);
});

// Real systems don't live-sync holiday calendars (see this endpoint's own
// framing on the Calendar page) — this is a one-time PRE-FILL convenience
// into the same editable HolidayCalendar/Holiday rows a person can also add
// to by hand, using a free, no-key public-holiday API. Not a replacement for
// manual curation: company-specific or regional days still need adding by
// hand afterward.
app.post("/holiday-calendars/fetch-public", async (req, res) => {
  const { name, countryCode, year } = req.body as { name?: string; countryCode?: string; year?: number };
  if (!name || !countryCode || !year) {
    res.status(400).json({ error: "name, countryCode, and year are required" });
    return;
  }

  let fetched: { date: string; name: string; localName: string }[];
  try {
    const response = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/${countryCode.toUpperCase()}`);
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    fetched = await response.json();
  } catch (error) {
    res.status(502).json({
      error: `Could not fetch public holidays for ${countryCode} ${year}: ${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }

  const holidayCalendar = await prisma.holidayCalendar.upsert({
    where: { name },
    create: { name },
    update: {},
  });

  const rows = fetched.map((h) => {
    const [y, m, d] = h.date.split("-").map(Number);
    return { holidayCalendarId: holidayCalendar.id, description: h.localName || h.name, day: d, month: m, year: y };
  });
  // skipDuplicates so re-running the fetch (or overlapping with a
  // manually-added holiday) doesn't error on the @@unique constraint.
  const result = await prisma.holiday.createMany({ data: rows, skipDuplicates: true });

  res.status(201).json({
    holidayCalendarId: holidayCalendar.id,
    name: holidayCalendar.name,
    holidaysFetched: rows.length,
    holidaysCreated: result.count,
  });
});

app.get("/shifts", async (_req, res) => {
  res.json(await prisma.shift.findMany());
});

app.post("/shifts", async (req, res) => {
  const { name, startTime, endTime, breakMinutes, daysOfWeek } = req.body;
  const shift = await prisma.shift.create({ data: { name, startTime, endTime, breakMinutes, daysOfWeek } });
  res.status(201).json(shift);
});

// The doc's named endpoint: working (non-holiday) calendar days for a
// plant within [start, end] — this is what the Constraint Engine's Holiday
// Calendar and Shift Calendar checks (§7) consult.
app.get("/calendar/working-periods", async (req, res) => {
  const { plantId, start, end } = req.query as { plantId?: string; start?: string; end?: string };
  if (!plantId || !start || !end) {
    res.status(400).json({ error: "plantId, start, and end are required" });
    return;
  }
  const days = await prisma.factoryCalendarDay.findMany({
    where: {
      calendar: { plantId },
      date: { gte: new Date(start), lte: new Date(end) },
      isWorking: true,
      isHoliday: false,
    },
    orderBy: { date: "asc" },
  });
  res.json(days);
});

registerErrorHandler(app);

app.listen(PORT, () => {
  logger.info(`calendar-service listening on :${PORT}`);
});
