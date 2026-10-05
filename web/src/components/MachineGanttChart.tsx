// §3 "Gantt / Graphic Scheduler: Time-based visual scheduler: machine +
// operator + tool rows + workload graph" (Proficy-style) — a machine-rows
// section and, only once any operation actually has a real assigned
// operator (see pipeline.ts's operator resolution), an operator-rows
// section in the SAME chart, not a separate tab. Tool rows remain omitted
// to keep the minimal UI genuinely minimal.

import type { LatenessStatus } from "@/lib/lateness";
import { OperationStatusActions } from "@/components/OperationStatusActions";

type Op = {
  id: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  productSku: string;
  status: string;
  productionOrderId: string;
  quantity: number;
  operationName: string | null;
  dueDate: Date | null;
  latenessStatus: LatenessStatus;
  metadata?: Record<string, unknown> | null;
  machineId?: string | null;
  machineName?: string | null;
  operatorName?: string | null;
  requiresInspection?: boolean;
};
// resourceSubtitle: for machine rows, the work center code — machine NAMES
// aren't unique (two independently-created work centers can both have a
// "CNC Mill 1"), so without this two distinct machines render as
// unexplained duplicate rows. Operator rows omit it (no work center
// concept applies).
export type ResourceRow = { resourceId: string; resourceName: string; resourceSubtitle?: string; ops: Op[] };

const PX_PER_HOUR = 24;
const ROW_HEIGHT = 44;

// BEAS/Proficy-style status coloring — done=green, in-progress=brand blue
// with a diagonal "active" stripe, not-started=a light steel-blue tint
// (never grey/black — this palette deliberately has no achromatic tones,
// see globals.css), blocked=red.
const STATUS_STYLES: Record<string, { className: string; striped?: boolean; label: string }> = {
  DONE: { className: "border-success bg-success text-white", label: "Done" },
  IN_PROGRESS: { className: "border-brand-700 bg-brand-600 text-white", striped: true, label: "In progress" },
  BLOCKED: { className: "border-danger bg-danger text-white", label: "Blocked" },
  PLANNED: { className: "border-brand-300 bg-brand-200 text-foreground", label: "Planned" },
  SCHEDULED: { className: "border-brand-300 bg-brand-200 text-foreground", label: "Scheduled" },
};
const DEFAULT_STATUS_STYLE = STATUS_STYLES.SCHEDULED;

// Corner dot layered on top of the status fill — a second, independent
// signal (will this miss its due date?) rather than overloading the same
// color used for execution status.
const LATENESS_DOT: Record<LatenessStatus, string | null> = {
  LATE: "bg-danger",
  AT_RISK: "bg-warning",
  ON_TRACK: null,
  NO_DUE_DATE: null,
};
const LATENESS_LABEL: Record<LatenessStatus, string> = {
  LATE: "Late",
  AT_RISK: "At risk",
  ON_TRACK: "On track",
  NO_DUE_DATE: "No due date",
};

function hoursBetween(a: Date, b: Date) {
  return (b.getTime() - a.getTime()) / 3_600_000;
}

function formatDateTime(d: Date) {
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function MachineGanttChart({
  machineRows,
  operatorRows = [],
}: {
  machineRows: ResourceRow[];
  operatorRows?: ResourceRow[];
}) {
  const allOps = [...machineRows, ...operatorRows].flatMap((r) => r.ops);
  if (allOps.length === 0) return null;

  const rangeStart = new Date(Math.min(...allOps.map((o) => o.scheduledStart.getTime())));
  const rangeEnd = new Date(Math.max(...allOps.map((o) => o.scheduledEnd.getTime())));
  const totalHours = Math.max(hoursBetween(rangeStart, rangeEnd) + 4, 24);
  const chartWidth = totalHours * PX_PER_HOUR;

  const hourMarkers = Array.from({ length: Math.ceil(totalHours / 6) + 1 }, (_, i) => i * 6);

  function renderResourceRow(row: ResourceRow) {
    return (
      <div key={row.resourceId} className="flex">
        <div
          className="flex w-40 shrink-0 flex-col justify-center gap-0.5 border-r border-b border-border px-3 text-sm font-medium text-foreground"
          style={{ height: ROW_HEIGHT }}
        >
          <span className="truncate">{row.resourceName}</span>
          {row.resourceSubtitle && (
            <span className="truncate text-[10px] font-normal uppercase tracking-wide text-muted">{row.resourceSubtitle}</span>
          )}
        </div>
        <div className="relative flex-1 border-b border-border" style={{ height: ROW_HEIGHT }}>
          {hourMarkers.map((offset) => (
            <div key={offset} className="absolute top-0 h-full border-l border-border/60" style={{ left: offset * PX_PER_HOUR }} />
          ))}
          {row.ops.map((op) => {
            const left = hoursBetween(rangeStart, op.scheduledStart) * PX_PER_HOUR;
            const width = Math.max(hoursBetween(op.scheduledStart, op.scheduledEnd) * PX_PER_HOUR, 8);
            const style = STATUS_STYLES[op.status] ?? DEFAULT_STATUS_STYLE;
            const latenessDot = LATENESS_DOT[op.latenessStatus];
            const metadataEntries = op.metadata ? Object.entries(op.metadata) : [];
            return (
              <div key={op.id} className="group absolute" style={{ left, width, top: 6, height: ROW_HEIGHT - 12 }}>
                <div
                  className={`relative flex h-full items-center overflow-hidden rounded-md border px-2 text-xs font-medium shadow-sm ${style.className}`}
                  style={{
                    backgroundImage: style.striped
                      ? "repeating-linear-gradient(45deg, rgba(255,255,255,0.18) 0 8px, transparent 8px 16px)"
                      : undefined,
                  }}
                >
                  <span className="truncate">{op.productSku} · {op.quantity}</span>
                </div>
                {latenessDot && (
                  // Sits on the OUTER (non-clipped) wrapper — the inner bar
                  // above has overflow-hidden for its rounded corners/text
                  // truncation, which was silently clipping this dot since it
                  // pokes outside the box on purpose (-top-1 -right-1).
                  <span
                    className={`pointer-events-none absolute -top-1 -right-1 z-10 h-2.5 w-2.5 rounded-full border border-white ${latenessDot}`}
                    aria-hidden
                  />
                )}

                {/* top-full with zero margin — a gap here (e.g. mt-1) creates a
                dead strip of pixels between the bar and this card where the
                mouse is over neither, breaking the CSS-only group-hover chain
                right as someone moves the cursor down to click a button
                inside it. Touching them exactly (pt-1 for the same visual
                breathing room, but as padding INSIDE the hoverable box
                instead of a margin outside it) keeps the hover state
                continuous the whole way down. */}
                <div className="pointer-events-none absolute left-0 top-full z-10 w-64 rounded-xl border border-border bg-surface p-3 pt-4 text-xs opacity-0 shadow-lg transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
                  <p className="font-semibold text-foreground">{op.productSku} · order #{op.productionOrderId.slice(-8)}</p>
                  {op.operationName && <p className="mt-1 text-muted">{op.operationName}</p>}
                  <dl className="mt-2 space-y-1 text-muted">
                    <div className="flex justify-between"><dt>Machine</dt><dd className="text-foreground">{op.machineName ?? "—"}</dd></div>
                    {op.operatorName && (
                      <div className="flex justify-between"><dt>Operator</dt><dd className="text-foreground">{op.operatorName}</dd></div>
                    )}
                    <div className="flex justify-between"><dt>Qty</dt><dd className="text-foreground">{op.quantity}</dd></div>
                    <div className="flex justify-between"><dt>Status</dt><dd className="text-foreground">{style.label}</dd></div>
                    <div className="flex justify-between"><dt>Start</dt><dd className="text-foreground">{formatDateTime(op.scheduledStart)}</dd></div>
                    <div className="flex justify-between"><dt>End</dt><dd className="text-foreground">{formatDateTime(op.scheduledEnd)}</dd></div>
                    <div className="flex justify-between">
                      <dt>Due date</dt>
                      <dd className="text-foreground">{op.dueDate ? formatDateTime(op.dueDate) : "—"}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt>Delivery risk</dt>
                      <dd className={latenessDot ? "font-medium text-foreground" : "text-foreground"}>
                        {LATENESS_LABEL[op.latenessStatus]}
                      </dd>
                    </div>
                  </dl>
                  {metadataEntries.length > 0 && (
                    <div className="mt-2 border-t border-border pt-2">
                      <p className="font-medium text-foreground">Extra fields</p>
                      <dl className="mt-1 space-y-1 text-muted">
                        {metadataEntries.map(([key, value]) => (
                          <div key={key} className="flex justify-between gap-2">
                            <dt className="truncate">{key}</dt>
                            <dd className="truncate text-foreground">{String(value)}</dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  )}
                  <div className="mt-2 border-t border-border pt-2">
                    <OperationStatusActions
                      operationId={op.id}
                      status={op.status}
                      scheduledStart={op.scheduledStart.toISOString()}
                      quantity={op.quantity}
                      machineId={op.machineId}
                      machineName={op.machineName}
                      requiresInspection={op.requiresInspection}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-2xl border border-border bg-surface">
      <div style={{ width: chartWidth + 160 }}>
        <div className="flex">
          <div className="w-40 shrink-0 border-b border-r border-border" />
          <div className="relative h-8 flex-1 border-b border-border">
            {hourMarkers.map((offset) => (
              <div
                key={offset}
                className="absolute top-0 h-full border-l border-border px-1.5 text-[11px] leading-8 text-muted"
                style={{ left: offset * PX_PER_HOUR }}
              >
                {new Date(rangeStart.getTime() + offset * 3_600_000).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                })}
              </div>
            ))}
          </div>
        </div>

        {machineRows.map((row) => renderResourceRow(row))}

        {operatorRows.length > 0 && (
          <div className="flex border-b border-border bg-surface-muted">
            <div className="w-40 shrink-0 border-r border-border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
              Operators
            </div>
            <div className="flex-1" />
          </div>
        )}
        {operatorRows.map((row) => renderResourceRow(row))}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border px-4 py-3 text-[11px] text-muted">
        {[STATUS_STYLES.SCHEDULED, STATUS_STYLES.IN_PROGRESS, STATUS_STYLES.DONE, STATUS_STYLES.BLOCKED].map((style) => (
          <span key={style.label} className="flex items-center gap-1.5">
            <span className={`h-2.5 w-2.5 rounded-sm border ${style.className}`} />
            {style.label}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-danger" />
          Late
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-warning" />
          At risk
        </span>
      </div>
    </div>
  );
}
