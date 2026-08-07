export type GridCellStatus = "holiday" | "non-working" | "down" | "fully-booked" | "partially-booked" | "available";

export type GridCell = { status: GridCellStatus; label: string };
export type GridRow = { machineId: string; machineName: string; workCenterCode: string; cells: GridCell[] };

const STATUS_STYLES: Record<GridCellStatus, string> = {
  holiday: "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300",
  "non-working": "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300",
  down: "bg-gray-300 text-gray-700 dark:bg-gray-700 dark:text-gray-200",
  "fully-booked": "bg-blue-500 text-white dark:bg-blue-600",
  "partially-booked": "bg-blue-200 text-blue-800 dark:bg-blue-900/60 dark:text-blue-200",
  available: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
};

const LEGEND: { status: GridCellStatus; label: string }[] = [
  { status: "available", label: "Available" },
  { status: "partially-booked", label: "Partially booked" },
  { status: "fully-booked", label: "Fully booked" },
  { status: "non-working", label: "Non-working day" },
  { status: "holiday", label: "Holiday" },
  { status: "down", label: "Machine down (today)" },
];

// Machines as rows, a rolling 14-day window as columns — this reads a
// multi-machine comparison better than a traditional 7-column month grid
// (better suited to browsing one resource at a time), which is what "which
// machine is free when" actually needs. Fixed window, no month navigation —
// kept deliberately small in scope.
export function CapacityCalendarGrid({ dates, rows }: { dates: Date[]; rows: GridRow[] }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-3">
        {LEGEND.map((item) => (
          <span key={item.status} className="flex items-center gap-1.5 text-xs text-muted">
            <span className={`h-3 w-3 rounded-sm ${STATUS_STYLES[item.status]}`} />
            {item.label}
          </span>
        ))}
      </div>

      <div className="overflow-x-auto rounded-2xl border border-border">
        <table className="w-full min-w-[960px] border-collapse text-sm">
          <thead className="bg-surface-muted text-left text-xs font-semibold uppercase tracking-wide text-muted">
            <tr>
              <th className="sticky left-0 z-10 bg-surface-muted px-4 py-3">Machine</th>
              {dates.map((date) => (
                <th key={date.toISOString()} className="px-2 py-3 text-center font-medium normal-case">
                  <div>{date.toLocaleDateString(undefined, { weekday: "short" })}</div>
                  <div className="text-muted">{date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={dates.length + 1} className="px-4 py-6 text-center text-muted">
                  No machines loaded yet.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.machineId}>
                  <td className="sticky left-0 z-10 bg-surface px-4 py-2 font-medium text-foreground">
                    {row.machineName}
                    <span className="ml-2 text-xs font-normal text-muted">{row.workCenterCode}</span>
                  </td>
                  {row.cells.map((cell, i) => (
                    <td key={i} className="p-1 text-center">
                      <span
                        title={cell.label}
                        className={`flex h-8 w-full items-center justify-center rounded-md text-[10px] font-medium ${STATUS_STYLES[cell.status]}`}
                      >
                        {cell.status === "fully-booked" || cell.status === "partially-booked" ? "●" : ""}
                      </span>
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
