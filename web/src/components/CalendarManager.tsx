"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import {
  addHolidayAction,
  fetchPublicHolidaysAction,
  updatePlantCalendarSettingsAction,
  updateWorkCenterCalendarAction,
} from "@/app/(app)/actions";

type HolidayCalendar = {
  id: string;
  name: string;
  holidays: { id: string; description: string; day: number; month: number; year: number }[];
};
type WorkCenter = { id: string; code: string; workingDaysOfWeek: number[]; holidayCalendarId: string | null };

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function DayPicker({ selected, onToggle }: { selected: number[]; onToggle: (day: number) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      {DAY_LABELS.map((label, day) => (
        <button
          key={day}
          type="button"
          onClick={() => onToggle(day)}
          className={`rounded-md px-2 py-1 text-xs font-medium ${
            selected.includes(day) ? "bg-brand-600 text-white" : "bg-surface-muted text-muted hover:text-foreground"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// Real SAP-style calendar management (transaction SCAL): a curated,
// reusable Holiday Calendar template, a per-plant working-days pattern, and
// per-Work-Center overrides — see pipeline.ts's resolveCalendarForWorkCenter
// for how these three feed the actual scheduler. Starts empty on purpose —
// this is master data a person adds, not something seeded for you.
export function CalendarManager({
  plantId,
  plantYear,
  holidayCalendars,
  plantWorkingDaysOfWeek,
  plantHolidayCalendarId,
  workCenters,
}: {
  plantId: string;
  plantYear: number;
  holidayCalendars: HolidayCalendar[];
  plantWorkingDaysOfWeek: number[];
  plantHolidayCalendarId: string | null;
  workCenters: WorkCenter[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? "Something went wrong");
        return;
      }
      router.refresh();
    });
  }

  // Add holiday form
  const [calendarName, setCalendarName] = useState("");
  const [description, setDescription] = useState("");
  const [day, setDay] = useState(1);
  const [month, setMonth] = useState(1);
  const [year, setYear] = useState(plantYear);

  // Fetch-public form
  const [fetchName, setFetchName] = useState("");
  const [countryCode, setCountryCode] = useState("US");
  const [fetchYear, setFetchYear] = useState(plantYear);
  const [fetchStatus, setFetchStatus] = useState<string | null>(null);

  // Plant working pattern form
  const [plantDays, setPlantDays] = useState<number[]>(plantWorkingDaysOfWeek);
  const [plantCalendarId, setPlantCalendarId] = useState<string>(plantHolidayCalendarId ?? "");

  return (
    <div className="flex flex-col gap-4">
      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="rounded-2xl border border-border bg-surface p-4">
        <h2 className="text-sm font-semibold text-foreground">Holiday Calendars</h2>
        <p className="mt-1 text-sm text-muted">
          Reusable, named holiday sets (e.g. &quot;US Federal Holidays&quot;) — curated once, then
          assigned to the plant or individual Work Centers below.
        </p>

        {holidayCalendars.length === 0 ? (
          <p className="mt-3 text-sm text-muted">No holiday calendars yet — add one below.</p>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {holidayCalendars.map((cal) => (
              <div key={cal.id} className="rounded-lg border border-border p-3">
                <p className="text-sm font-medium text-foreground">{cal.name} <span className="font-normal text-muted">({cal.holidays.length} holiday{cal.holidays.length === 1 ? "" : "s"})</span></p>
                {cal.holidays.length > 0 && (
                  <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                    {cal.holidays
                      .slice()
                      .sort((a, b) => a.year - b.year || a.month - b.month || a.day - b.day)
                      .map((h) => (
                        <li key={h.id}>
                          {h.year}-{String(h.month).padStart(2, "0")}-{String(h.day).padStart(2, "0")} — {h.description}
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(() => addHolidayAction({ calendarName, description, day, month, year }));
          }}
          className="mt-4 flex flex-wrap items-end gap-3 border-t border-border pt-4"
        >
          <Input list="calendar-names" label="Calendar name" value={calendarName} onChange={(e) => setCalendarName(e.target.value)} required />
          <datalist id="calendar-names">
            {holidayCalendars.map((c) => (
              <option key={c.id} value={c.name} />
            ))}
          </datalist>
          <Input label="Description" value={description} onChange={(e) => setDescription(e.target.value)} required />
          <Input label="Day" type="number" min={1} max={31} value={day} onChange={(e) => setDay(Number(e.target.value))} required />
          <Input label="Month" type="number" min={1} max={12} value={month} onChange={(e) => setMonth(Number(e.target.value))} required />
          <Input label="Year" type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} required />
          <Button type="submit" size="sm" disabled={isPending}>Add holiday</Button>
        </form>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            setFetchStatus(null);
            startTransition(async () => {
              const result = await fetchPublicHolidaysAction({ name: fetchName, countryCode, year: fetchYear });
              if (!result.ok) {
                setError(result.error ?? "Fetch failed");
                return;
              }
              setFetchStatus(`Fetched ${result.result.holidaysFetched} holidays, added ${result.result.holidaysCreated} new`);
              router.refresh();
            });
          }}
          className="mt-4 flex flex-wrap items-end gap-3 border-t border-border pt-4"
        >
          <Input label="New calendar name" value={fetchName} onChange={(e) => setFetchName(e.target.value)} required placeholder="e.g. US Public Holidays" />
          <Input label="Country code" value={countryCode} onChange={(e) => setCountryCode(e.target.value.toUpperCase())} required placeholder="US" maxLength={2} />
          <Input label="Year" type="number" value={fetchYear} onChange={(e) => setFetchYear(Number(e.target.value))} required />
          <Button type="submit" size="sm" variant="secondary" disabled={isPending}>Fetch public holidays</Button>
          {fetchStatus && <span className="text-xs text-muted">{fetchStatus}</span>}
        </form>
        <p className="mt-2 text-xs text-muted">
          Pre-fills national public holidays from a free API (Nager.Date) into an editable calendar
          above — a one-time convenience, not a live sync. Add company-specific days by hand.
        </p>
      </div>

      <div className="rounded-2xl border border-border bg-surface p-4">
        <h2 className="text-sm font-semibold text-foreground">Plant working pattern</h2>
        <p className="mt-1 text-sm text-muted">The default for every Work Center that doesn&apos;t set its own override below.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(() => updatePlantCalendarSettingsAction(plantId, plantYear, { workingDaysOfWeek: plantDays, holidayCalendarId: plantCalendarId || null }));
          }}
          className="mt-3 flex flex-wrap items-end gap-4"
        >
          <div>
            <p className="mb-1 text-xs font-medium text-muted">Working days</p>
            <DayPicker selected={plantDays} onToggle={(d) => setPlantDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort()))} />
          </div>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-muted">Holiday calendar</span>
            <select
              value={plantCalendarId}
              onChange={(e) => setPlantCalendarId(e.target.value)}
              className="h-9 rounded-lg border border-border bg-surface px-2 text-sm text-foreground"
            >
              <option value="">None</option>
              {holidayCalendars.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <Button type="submit" size="sm" disabled={isPending}>Save</Button>
        </form>
      </div>

      <div className="rounded-2xl border border-border bg-surface p-4">
        <h2 className="text-sm font-semibold text-foreground">Work Center overrides</h2>
        <p className="mt-1 text-sm text-muted">
          Real SAP-style multi-level assignment (Plant, Work Center, Personnel Area) — a work center
          can run its own pattern instead of the plant default above.
        </p>
        {workCenters.length === 0 ? (
          <p className="mt-3 text-sm text-muted">No work centers loaded yet.</p>
        ) : (
          <div className="mt-3 flex flex-col gap-3">
            {workCenters.map((wc) => (
              <WorkCenterOverrideRow key={wc.id} workCenter={wc} holidayCalendars={holidayCalendars} onSave={run} isPending={isPending} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function WorkCenterOverrideRow({
  workCenter,
  holidayCalendars,
  onSave,
  isPending,
}: {
  workCenter: WorkCenter;
  holidayCalendars: HolidayCalendar[];
  onSave: (action: () => Promise<{ ok: boolean; error?: string }>) => void;
  isPending: boolean;
}) {
  const [days, setDays] = useState<number[]>(workCenter.workingDaysOfWeek);
  const [calendarId, setCalendarId] = useState<string>(workCenter.holidayCalendarId ?? "");

  return (
    <div className="flex flex-wrap items-end gap-4 rounded-lg border border-border p-3">
      <span className="text-sm font-medium text-foreground">{workCenter.code}</span>
      <div>
        <p className="mb-1 text-xs font-medium text-muted">Working days (blank = inherit plant)</p>
        <DayPicker selected={days} onToggle={(d) => setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort()))} />
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs font-medium text-muted">Holiday calendar</span>
        <select
          value={calendarId}
          onChange={(e) => setCalendarId(e.target.value)}
          className="h-9 rounded-lg border border-border bg-surface px-2 text-sm text-foreground"
        >
          <option value="">Inherit from plant</option>
          {holidayCalendars.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </label>
      <Button
        type="button"
        size="sm"
        disabled={isPending}
        onClick={() => onSave(() => updateWorkCenterCalendarAction(workCenter.id, { workingDaysOfWeek: days, holidayCalendarId: calendarId || null }))}
      >
        Save
      </Button>
    </div>
  );
}
