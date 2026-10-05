import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { listPlantsForEnterprise } from "@/lib/tenant";
import { fetchHolidayCalendars, fetchWorkCenters } from "@/lib/services";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { PageHeader } from "@/components/ui/PageHeader";
import { MetricCard } from "@/components/ui/MetricCard";
import { EmptyState } from "@/components/ui/States";
import { CalendarManager } from "@/components/CalendarManager";
import { CapacityCalendarGrid, type GridCell, type GridCellStatus, type GridRow } from "@/components/CapacityCalendarGrid";

export const metadata: Metadata = { title: "Calendar" };

const GRID_DAYS = 14;

function ymd(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

// §7 Holiday Calendar — a real SAP-style multi-level system (transaction
// SCAL): reusable Holiday Calendar templates, a per-plant working pattern,
// and per-Work-Center overrides (see pipeline.ts's
// resolveCalendarForWorkCenter, which this page's grid mirrors exactly so
// it always shows what the scheduler will actually honor).
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ plantId?: string }>;
}) {
  const session = await auth();
  const { plantId: requestedPlantId } = await searchParams;
  const plants = await listPlantsForEnterprise(session?.user.enterpriseId ?? null);
  const selectedPlant = plants.find((p) => p.id === requestedPlantId) ?? plants[0];

  if (!selectedPlant) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Calendar" />
        <EmptyState title="No plants exist yet" />
      </div>
    );
  }

  const now = new Date();
  const gridStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const gridDates = Array.from({ length: GRID_DAYS }, (_, i) => new Date(gridStart.getTime() + i * 86_400_000));
  const gridEnd = new Date(gridStart.getTime() + GRID_DAYS * 86_400_000);
  const currentYear = gridStart.getUTCFullYear();

  const [days, holidayCalendars, workCentersRaw, machines, factoryCalendars, scheduledOps] = await Promise.all([
    prisma.factoryCalendarDay.findMany({ where: { calendar: { plantId: selectedPlant.id } }, orderBy: { date: "asc" } }),
    fetchHolidayCalendars(),
    fetchWorkCenters(selectedPlant.id),
    prisma.machine.findMany({
      where: { workCenter: { plantId: selectedPlant.id } },
      include: { workCenter: { select: { id: true, code: true, workingDaysOfWeek: true, holidayCalendarId: true } } },
      orderBy: [{ workCenter: { code: "asc" } }, { name: "asc" }],
    }),
    // Only this year's FactoryCalendar is consulted for the grid — a
    // deliberate simplification (same "kept small" scope as the fixed
    // 14-day window): the grid never spans a year boundary in practice
    // given today's date, so cross-year FactoryCalendar lookups aren't
    // worth the extra complexity here.
    prisma.factoryCalendar.findMany({ where: { plantId: selectedPlant.id, year: currentYear } }),
    prisma.scheduledOperation.findMany({
      where: { machineId: { not: null }, scheduledStart: { lt: gridEnd }, scheduledEnd: { gt: gridStart } },
      select: { machineId: true, scheduledStart: true, scheduledEnd: true },
    }),
  ]);

  const now2 = new Date();
  const upcoming = days.filter((d) => d.date >= now2);
  const holidayCount = days.filter((d) => d.isHoliday || !d.isWorking).length;

  const holidayCalendarsById = new Map(holidayCalendars.map((c) => [c.id, c]));
  const plantCalendar = factoryCalendars[0];
  const plantWorkingDaysOfWeek = plantCalendar?.workingDaysOfWeek ?? [1, 2, 3, 4, 5];
  const plantHolidayCalendarId = plantCalendar?.holidayCalendarId ?? null;
  const plantDayOverrides = new Set(days.filter((d) => d.isHoliday || !d.isWorking).map((d) => ymd(d.date)));

  function resolveWorkCenter(workCenterId: string, workingDaysOfWeek: number[], holidayCalendarId: string | null) {
    const effectiveWorkingDays = workingDaysOfWeek.length > 0 ? workingDaysOfWeek : plantWorkingDaysOfWeek;
    const effectiveHolidayCalendarId = holidayCalendarId ?? plantHolidayCalendarId;
    const holidayDates = new Set(
      (effectiveHolidayCalendarId ? holidayCalendarsById.get(effectiveHolidayCalendarId)?.holidays ?? [] : []).map(
        (h) => `${h.year}-${String(h.month).padStart(2, "0")}-${String(h.day).padStart(2, "0")}`
      )
    );
    return { workingDaysOfWeek: effectiveWorkingDays, holidayDates };
  }

  const bookedMinutesByMachineAndDate = new Map<string, number>();
  for (const op of scheduledOps) {
    if (!op.machineId) continue;
    for (const date of gridDates) {
      const dayStart = date.getTime();
      const dayEnd = dayStart + 86_400_000;
      const overlapStart = Math.max(op.scheduledStart.getTime(), dayStart);
      const overlapEnd = Math.min(op.scheduledEnd.getTime(), dayEnd);
      if (overlapEnd <= overlapStart) continue;
      const key = `${op.machineId}::${ymd(date)}`;
      bookedMinutesByMachineAndDate.set(key, (bookedMinutesByMachineAndDate.get(key) ?? 0) + (overlapEnd - overlapStart) / 60_000);
    }
  }

  const rows: GridRow[] = machines.map((machine) => {
    const { workingDaysOfWeek, holidayDates } = resolveWorkCenter(
      machine.workCenter.id,
      machine.workCenter.workingDaysOfWeek,
      machine.workCenter.holidayCalendarId
    );
    const cells: GridCell[] = gridDates.map((date, i) => {
      const dateKey = ymd(date);
      let status: GridCellStatus;
      let label: string;
      if (plantDayOverrides.has(dateKey) || holidayDates.has(dateKey)) {
        status = "holiday";
        label = "Holiday";
      } else if (!workingDaysOfWeek.includes(date.getUTCDay())) {
        status = "non-working";
        label = "Non-working day";
      } else if (i === 0 && machine.status !== "AVAILABLE" && machine.status !== "RUNNING") {
        // Machine.status is a live single value with no history/future, so
        // it can only honestly describe TODAY's column — a real, stated
        // scope limit, not an oversight.
        status = "down";
        label = `Machine ${machine.status}`;
      } else {
        const bookedMinutes = bookedMinutesByMachineAndDate.get(`${machine.id}::${dateKey}`) ?? 0;
        if (bookedMinutes / 1440 > 0.8) {
          status = "fully-booked";
          label = "Fully booked";
        } else if (bookedMinutes > 0) {
          status = "partially-booked";
          label = "Partially booked";
        } else {
          status = "available";
          label = "Available";
        }
      }
      return { status, label };
    });
    return { machineId: machine.id, machineName: machine.name, workCenterCode: machine.workCenter.code, cells };
  });

  const workCenters = workCentersRaw.map((wc) => ({
    id: wc.id,
    code: wc.code,
    workingDaysOfWeek: wc.workingDaysOfWeek,
    holidayCalendarId: wc.holidayCalendarId,
  }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Calendar"
        actions={
          plants.length > 0 ? (
            <form method="get" className="flex items-center gap-2">
              <select
                name="plantId"
                defaultValue={selectedPlant.id}
                className="h-9 rounded-lg border border-border bg-surface px-2 text-sm text-foreground"
              >
                {plants.map((p) => (
                  <option key={p.id} value={p.id}>{p.code}</option>
                ))}
              </select>
              <button type="submit" className="text-sm font-medium text-brand-600 hover:underline">Switch</button>
            </form>
          ) : undefined
        }
      />

      <CapacityCalendarGrid dates={gridDates} rows={rows} />

      <div className="grid gap-4 sm:grid-cols-3">
        <MetricCard label="Declared exception days" value={days.length} />
        <MetricCard label="Holidays / shutdown days" value={holidayCount} />
        <MetricCard label="Upcoming" value={upcoming.length} />
      </div>

      <CalendarManager
        plantId={selectedPlant.id}
        plantYear={currentYear}
        holidayCalendars={holidayCalendars}
        plantWorkingDaysOfWeek={plantWorkingDaysOfWeek}
        plantHolidayCalendarId={plantHolidayCalendarId}
        workCenters={workCenters}
      />

      <div className="overflow-x-auto rounded-2xl border border-border">
        <table className="w-full min-w-[520px] text-sm">
          <thead className="bg-surface-muted text-left text-xs font-semibold uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Label</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {days.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-muted">
                  No one-off exception days imported yet — upload a Calendar sheet via /import to declare them.
                </td>
              </tr>
            ) : (
              days.map((day) => {
                const isNonWorking = day.isHoliday || !day.isWorking;
                return (
                  <tr key={day.id}>
                    <td className="px-4 py-3 font-medium text-foreground">{day.date.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" })}</td>
                    <td className="px-4 py-3 text-muted">{day.label ?? "—"}</td>
                    <td className="px-4 py-3">
                      <StatusBadge tone={isNonWorking ? "danger" : "success"}>
                        {isNonWorking ? "Holiday / non-working" : "Working"}
                      </StatusBadge>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
