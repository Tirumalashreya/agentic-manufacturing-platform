import type { TimeWindow } from "./constraint-engine";

export type RecurringShift = { startTime: string; endTime: string; daysOfWeek: number[] };

const DAY_MS = 86_400_000;

function parseHHMM(value: string): { hours: number; minutes: number } {
  const [hours, minutes] = value.split(":").map(Number);
  return { hours, minutes };
}

// Expands recurring `Shift` rows ("HH:MM" + daysOfWeek) into concrete,
// date-bound windows covering [rangeStart, rangeEnd]. Walks one extra day
// before rangeStart so an overnight shift (endTime <= startTime, e.g.
// 22:00-06:00) that starts the previous calendar day but extends into
// rangeStart isn't missed.
export function expandShiftWindows(shifts: RecurringShift[], rangeStart: Date, rangeEnd: Date): TimeWindow[] {
  const windows: TimeWindow[] = [];
  const walkStart = Math.floor((rangeStart.getTime() - DAY_MS) / DAY_MS) * DAY_MS;

  for (let t = walkStart; t <= rangeEnd.getTime(); t += DAY_MS) {
    const day = new Date(t);
    const dayOfWeek = day.getDay();
    for (const shift of shifts) {
      if (!shift.daysOfWeek.includes(dayOfWeek)) continue;
      const { hours: startH, minutes: startM } = parseHHMM(shift.startTime);
      const { hours: endH, minutes: endM } = parseHHMM(shift.endTime);

      const start = new Date(day);
      start.setHours(startH, startM, 0, 0);
      let end = new Date(day);
      end.setHours(endH, endM, 0, 0);
      if (end <= start) end = new Date(end.getTime() + DAY_MS); // overnight shift

      if (end > rangeStart && start < rangeEnd) windows.push({ start, end });
    }
  }
  return windows.sort((a, b) => a.start.getTime() - b.start.getTime());
}
